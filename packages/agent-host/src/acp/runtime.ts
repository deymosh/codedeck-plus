/**
 * The ACP process pool: one child process per environment, shared by every
 * session started in it, plus the ACP connection to each.
 *
 * One process serves every session started in the SAME environment. That is
 * ACP's own model — a session is an id inside one connection — and it is what
 * makes several sessions of one bridge share one boot. An environment is the
 * unit because a session's provider binding is: a session bound to a gateway
 * needs a base URL and a token the native session must not have, so a binding
 * change means a different process rather than one connection carrying two
 * conflicting sets of credentials. Processes are reference-counted by their
 * sessions and closed once the last one lets go — after a grace period, so a
 * bridge restart does not pay a fresh boot per session — and always on
 * shutdown.
 *
 * What the agent is, and how it starts, is the driver's: `entryPoint` and
 * `spec` say so, and `stderr` reads whatever the agent logs on the one stream
 * ACP does not own. Everything else here is the same for every ACP agent.
 *
 * A process hands each of its sessions its own messages: a session attaches
 * before it prompts, and detaches as it ends. A message for a session nobody
 * has attached yet is dropped — the agent answers `session/new` before it has
 * anything to say about it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type {
  ClientCapabilities,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { AcpClient, INITIALIZE_TIMEOUT_MS } from './acp';

/** The ACP revision this client speaks; the agent answers with its own. */
const ACP_PROTOCOL_VERSION = 1;

/** Injectable spawn seam for tests. */
export type SpawnFn = typeof spawn;

/** Milliseconds a process stays up after its last session ends. */
const IDLE_CLOSE_MS = 120_000;
/** Grace period between SIGTERM and SIGKILL. */
const CLOSE_GRACE_MS = 5_000;

/** What a session wants from the connection it shares. */
export interface AcpSessionHandler {
  /** One `session/update` notification bound for this session. */
  update(notification: SessionNotification): void;
  /** The agent is asking the user to allow or refuse a tool call. */
  permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** An extension request the agent sent for this session — a method ACP
   *  does not define, whose params carry the `sessionId` it routes by.
   *  `undefined` leaves it to the default `-32601`, so a method the driver
   *  does not claim is refused at once rather than left hanging. */
  extRequest?(method: string, params: Record<string, unknown>): Promise<unknown> | undefined;
}

/** What the driver is told about a process, whichever sessions it serves. */
export interface AcpProcessEvents {
  /** The process is gone: every session it served has ended. */
  ended(sessionIds: readonly string[], error: string): void;
}

/** How to start one process: the command, the child's environment, and
 *  whatever the driver wants to read back from the process. */
export interface AcpProcessSpec<H> {
  command: string;
  args: string[];
  /** The child's environment: the session's own, plus what the agent needs. */
  env: Record<string, string>;
  /** Anything the driver attaches to this process (its own auxiliary
   *  channel, say). Opaque here, handed back on the process. */
  handle: H;
  /** What the start line says about how this process was started, after the
   *  pid — the mode or profile the agent was launched in, say. */
  detail?: string;
}

/** One live agent process. */
export interface AcpProcess<H> {
  readonly client: AcpClient;
  /** What the agent said it implements, from `initialize`. */
  readonly capabilities: NonNullable<InitializeResponse['agentCapabilities']>;
  /** What the agent said about itself in `initialize` — its name and version
   *  — when it said anything. */
  readonly agentInfo: InitializeResponse['agentInfo'];
  readonly pid: number | undefined;
  /** What the driver's spawn spec attached to this process. */
  readonly handle: H;
  /** The driver's configuration version as it was when this process started:
   *  a change since is configuration this process has not loaded. */
  readonly configVersion: number;
  /** Whether the process can still serve a session. */
  readonly alive: boolean;
  /** Take the messages of one session. */
  attach(sessionId: string, handler: AcpSessionHandler): void;
  /** Stop taking them (the session is over). */
  detach(sessionId: string): void;
  /** Let go of this process: the runtime closes it once it was the last. */
  release(): void;
}

export interface AcpRuntimeOptions {
  log: (message: string) => void;
  /** The tag every log line carries, so one agent's pool is told from
   *  another's. */
  tag: string;
  /** How the agent reads in the messages a person sees (an ended session's
   *  error, say). */
  label: string;
  /** What this client implements, sent in `initialize`. Default: nothing. */
  clientCapabilities?: ClientCapabilities;
  /** Spawn seam for tests. */
  spawnFn?: SpawnFn;
  /** A counter that changes when the configuration a process loads changes,
   *  read at each spawn. The runtime does not know what that configuration
   *  is; the driver that owns it does. */
  configVersion?: () => number;
  /** How long a process outlives its last session (0 to close at once). */
  idleCloseMs?: number;
}

/** One environment's process, with the sessions using it. */
interface Context<H> {
  readonly key: string;
  /** The configuration version this process was started with. A version
   *  change means a different process: the live one has not loaded the
   *  change, and a session started after it must. */
  readonly version: number;
  /** Settles with the live process, or rejects when it could not start. */
  opened: Promise<AgentProcess<H>>;
  /** Sessions that have acquired and not yet released it. */
  sessions: number;
  /** Every session let go and the process is on its way out: a new session
   *  needs a new one. */
  closing: boolean;
  /** The idle close waiting to happen. */
  timer?: NodeJS.Timeout;
  /** The process, once it is up. */
  live?: AgentProcess<H>;
}

/** What the process tells the runtime. */
interface ProcessHooks<H> {
  log: (message: string) => void;
  gone: (process_: AgentProcess<H>) => void;
  release: (process_: AgentProcess<H>) => void;
  ended: (sessionIds: readonly string[], error: string) => void;
  /** A line the child wrote on stderr: true when the driver handled it, so
   *  it is not also logged. */
  stderr: (line: string, process_: AgentProcess<H>) => boolean;
  /** The child has exited; the driver removes whatever it made for it. */
  cleanup: (process_: AgentProcess<H>) => void;
}

/** The identity of one environment: same variables, same process. The hash is
 *  never logged — the environment carries credentials. */
function envKeyOf(env: Record<string, string>): string {
  const sorted = Object.keys(env)
    .sort()
    .map((key) => [key, env[key]]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 32);
}

/** One spawned child, wrapped as the ACP connection the driver uses. */
class AgentProcess<H> implements AcpProcess<H> {
  /** What the agent answered `initialize` with; filled in by the runtime
   *  before the process is handed to a session. */
  capabilities: NonNullable<InitializeResponse['agentCapabilities']> = {};
  agentInfo: InitializeResponse['agentInfo'] = null;
  readonly configVersion: number;
  private readonly handlers = new Map<string, AcpSessionHandler>();
  private readonly decoder = new StringDecoder('utf8');
  private stderrBuffer = '';
  private gone = false;

  constructor(
    private readonly child: ChildProcess,
    readonly client: AcpClient,
    configVersion: number,
    readonly handle: H,
    private readonly tag: string,
    private readonly label: string,
    private readonly hooks: ProcessHooks<H>,
  ) {
    this.configVersion = configVersion;
    this.client.on('session/update', (notification) => {
      const handler = this.handlers.get(notification.sessionId);
      if (handler) handler.update(notification);
      else hooks.log(`[${tag}] dropped an update for unknown session ${notification.sessionId}`);
    });
    this.client.onRequest('session/request_permission', async (request): Promise<RequestPermissionResponse> => {
      const handler = this.handlers.get(request.sessionId);
      if (!handler) {
        // Nobody is waiting on this ask: refusing is the only safe answer to
        // a tool call whose session is gone.
        return { outcome: { outcome: 'cancelled' } };
      }
      return handler.permission(request);
    });
    // A method ACP does not define is the driver's, routed to the session its
    // params name. One no session claims stays unclaimed, and the client
    // answers `-32601`.
    this.client.onUnknownRequest((method, params) => {
      const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
      const handler = typeof sessionId === 'string' ? this.handlers.get(sessionId) : undefined;
      return handler?.extRequest?.(method, params as Record<string, unknown>);
    });

    // The agent logs its own diagnostics on stderr (ACP owns stdout).
    child.stderr?.on('data', (chunk: Buffer) => this.readStderr(chunk));
    child.on('error', (error) => {
      hooks.log(`[${tag}] could not start the agent: ${error.message}`);
      this.client.finish({ error: error.message });
    });
    child.on('exit', (code, signal) => {
      hooks.cleanup(this);
      this.client.finish({ error: `the ${label} process exited (${signal ? `signal ${signal}` : `code ${code ?? '?'}`})` });
    });
    void this.client.closed.then((closed) => {
      if (this.gone) return;
      this.gone = true;
      const sessionIds = [...this.handlers.keys()];
      this.handlers.clear();
      hooks.gone(this);
      const error = closed.error ?? `the ${label} process was closed`;
      hooks.log(`[${tag}] the agent process is gone: ${error}`);
      hooks.ended(sessionIds, error);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.gone && this.client.isOpen;
  }

  attach(sessionId: string, handler: AcpSessionHandler): void {
    this.handlers.set(sessionId, handler);
  }

  detach(sessionId: string): void {
    this.handlers.delete(sessionId);
  }

  release(): void {
    this.hooks.release(this);
  }

  /** A clean shutdown: SIGTERM, then SIGKILL if the agent does not go. */
  close(): Promise<void> {
    this.client.finish({ error: 'the agent host is shutting down' });
    return new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const kill = setTimeout(() => this.child.kill('SIGKILL'), CLOSE_GRACE_MS);
      kill.unref?.();
      this.child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      this.child.kill('SIGTERM');
    });
  }

  private readStderr(chunk: Buffer): void {
    this.stderrBuffer += this.decoder.write(chunk);
    for (;;) {
      const end = this.stderrBuffer.indexOf('\n');
      if (end < 0) return;
      const line = this.stderrBuffer.slice(0, end).replace(/\r$/, '');
      this.stderrBuffer = this.stderrBuffer.slice(end + 1);
      if (line.trim() === '') continue;
      // A line the driver claimed is the driver's, not the log's.
      if (this.hooks.stderr(line, this)) continue;
      this.hooks.log(`[${this.tag}] ${line}`);
    }
  }
}

/**
 * The process pool one agent's driver runs on. A subclass says how to find
 * the agent's entry point and how to start one process; everything else —
 * sharing, respawn, the idle close, `initialize` — is the same for every ACP
 * agent.
 */
export abstract class AcpRuntime<H = undefined, E extends AcpProcessEvents = AcpProcessEvents> {
  private readonly contexts = new Map<string, Context<H>>();
  protected readonly log: (message: string) => void;
  private stopping = false;

  constructor(private readonly options: AcpRuntimeOptions) {
    this.log = options.log;
  }

  /** The agent's CLI entry point: the operator's own, else installed. */
  abstract entryPoint(): Promise<string>;

  /** How to start one process, from the entry point and the session's own
   *  environment. */
  protected abstract spec(entry: string, env: Record<string, string>): AcpProcessSpec<H>;

  /** A line the child wrote on stderr. Return true when the driver handled
   *  it, so it is not also logged. */
  protected stderr?(line: string, process_: AcpProcess<H>, events: E): boolean;

  /** The child has exited: the driver removes whatever it made for it. */
  protected cleanup?(process_: AcpProcess<H>): void;

  /** The connection for one session's environment, started on first use. */
  async acquire(env: Record<string, string>, events: E): Promise<AcpProcess<H>> {
    if (this.stopping) throw new Error('the agent host is shutting down');
    const key = envKeyOf(env);
    const context = this.open(key, env, events);
    context.sessions++;
    try {
      return await context.opened;
    } catch (error) {
      // A start that failed leaves nothing behind: the next session retries.
      context.sessions--;
      if (context.sessions <= 0) this.forget(key, context);
      throw error;
    }
  }

  /** Close every process. Called on host shutdown. */
  async close(): Promise<void> {
    this.stopping = true;
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    await Promise.all(
      contexts.map(async (context) => {
        context.closing = true;
        if (context.timer) clearTimeout(context.timer);
        try {
          await (await context.opened).close();
        } catch {
          // A start that failed has nothing to close.
        }
      }),
    );
  }

  /** The context for one key: the live one while it can still serve, else a
   *  fresh process. */
  private open(key: string, env: Record<string, string>, events: E): Context<H> {
    const version = this.options.configVersion?.() ?? 0;
    const existing = this.contexts.get(key);
    if (
      existing &&
      existing.version === version &&
      !existing.closing &&
      (existing.live === undefined || existing.live.alive)
    ) {
      if (existing.timer) {
        clearTimeout(existing.timer);
        existing.timer = undefined;
      }
      return existing;
    }
    // A different version starts a process of its own: sessions already on the
    // old one keep it (they are released normally, closing it when the last
    // lets go), while every session from now on gets the new configuration.
    if (existing) {
      if (existing.timer) {
        clearTimeout(existing.timer);
        existing.timer = undefined;
      }
      if (existing.sessions === 0) void existing.live?.close();
    }
    const context: Context<H> = { key, version, opened: undefined as never, sessions: 0, closing: false };
    this.contexts.set(key, context);
    context.opened = this.spawn(context, env, events);
    return context;
  }

  private async spawn(context: Context<H>, env: Record<string, string>, events: E): Promise<AgentProcess<H>> {
    const entry = await this.entryPoint();
    const spec = this.spec(entry, env);
    const child = (this.options.spawnFn ?? spawn)(spec.command, spec.args, {
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const process_ = new AgentProcess<H>(
      child,
      new AcpClient({ stdin: child.stdin!, stdout: child.stdout!, log: this.log, tag: this.options.tag }),
      context.version,
      spec.handle,
      this.options.tag,
      this.options.label,
      {
        log: this.log,
        gone: (gone) => this.forget(context.key, context, gone),
        release: (released) => this.release(context, released),
        ended: (sessionIds, error) => events.ended(sessionIds, error),
        stderr: (line, process__) => this.stderr?.(line, process__, events) ?? false,
        cleanup: (process__) => this.cleanup?.(process__),
      },
    );
    // The connection is initialized before any session uses it: the agent
    // answers with what it implements, and an agent that cannot boot fails
    // here rather than on the first prompt.
    try {
      const initialized = await process_.client.request(
        'initialize',
        { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: this.options.clientCapabilities ?? {} },
        { timeoutMs: INITIALIZE_TIMEOUT_MS },
      );
      process_.capabilities = initialized.agentCapabilities ?? {};
      process_.agentInfo = initialized.agentInfo;
    } catch (error) {
      process_.client.finish({ error: 'the agent did not initialize' });
      await process_.close();
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (this.stopping || context.closing) {
      await process_.close();
      throw new Error('the agent host is shutting down');
    }
    context.live = process_;
    this.log(`[${this.options.tag}] started ${this.options.label} (pid ${child.pid ?? '?'}${spec.detail ? `, ${spec.detail}` : ''})`);
    return process_;
  }

  /** A process went away: it is no longer this environment's process, and
   *  the next session starts a new one. */
  private forget(key: string, context: Context<H>, process_?: AgentProcess<H>): void {
    const current = this.contexts.get(key);
    if (current !== context) return;
    if (process_ && current.live && current.live !== process_) return;
    if (current.timer) clearTimeout(current.timer);
    this.contexts.delete(key);
  }

  /** One session let go: close the process once nobody is using it, after a
   *  grace period so a bridge restart does not pay a boot per session. */
  private async release(context: Context<H>, process_: AgentProcess<H>): Promise<void> {
    context.sessions = Math.max(0, context.sessions - 1);
    if (context.sessions > 0) return;
    const idle = this.options.idleCloseMs ?? IDLE_CLOSE_MS;
    if (idle > 0 && !this.stopping) {
      context.timer = setTimeout(() => void this.closeIdle(context), idle);
      context.timer.unref?.();
      return;
    }
    context.closing = true;
    this.forget(context.key, context);
    await process_.close();
  }

  private async closeIdle(context: Context<H>): Promise<void> {
    context.timer = undefined;
    // A session that arrived while the timer ran keeps the process.
    if (context.sessions > 0) return;
    context.closing = true;
    // A context replaced for a newer configuration is no longer the map's,
    // but its process is still this one's to close.
    this.forget(context.key, context);
    this.log(`[${this.options.tag}] closing the idle agent process`);
    await context.live?.close();
  }
}
