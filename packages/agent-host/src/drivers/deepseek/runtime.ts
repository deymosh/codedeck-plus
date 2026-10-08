/**
 * The `dsh --profile acp` process behind the driver: where its entry point
 * comes from, the environment it runs in, and the ACP connection to it.
 *
 * One process serves every session started in the SAME environment. That is
 * ACP's own model — a session is an id inside one connection — and it is what
 * makes several sessions of one bridge share one harness boot. An environment
 * is the unit because a session's provider binding is: a session bound to a
 * gateway needs a base URL and a token the native session must not have, so a
 * binding change means a different process rather than one connection
 * carrying two conflicting sets of credentials. Processes are reference-
 * counted by their sessions and closed once the last one lets go — after a
 * grace period, so a bridge restart does not pay a fresh harness boot per
 * session — and always on shutdown.
 *
 * The harness's own state — profiles, sessions, credentials — lives under
 * `$DSH_HOME`, the one variable every environment shares: the conversation a
 * session resumes is on disk, not in the process.
 *
 * A process hands each of its sessions its own messages: a session attaches
 * before it prompts, and detaches as it ends. A message for a session nobody
 * has attached yet is dropped — the harness answers `session/new` before it
 * has anything to say about it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { agentCacheDir } from '../../install/agentInstall';
import { isFile } from '../../sdk/executable';
import { AcpClient, INITIALIZE_TIMEOUT_MS } from './acp';
import { bridgeSocketPath } from './bridge';
import { DSH_LABEL } from './install';
import { BRIDGE_SOCKET_ENV, QUESTION_MARKER } from './plugin';

/** The ACP profile the driver runs: the automation surface, ACP on stdio. */
export const DSH_PROFILE = 'acp';
/** The ACP revision this client speaks; the harness answers with its own. */
const ACP_PROTOCOL_VERSION = 1;

/** How the harness reports one MCP server's trouble on stderr, e.g.
 *  `mcp-client(demo): ...`. */
const MCP_FAILURE = /mcp-client\(([^)]+)\)/;

/** Injectable spawn seam for tests. */
export type SpawnFn = typeof spawn;

/** Milliseconds a process stays up after its last session ends. */
const IDLE_CLOSE_MS = 120_000;
/** Grace period between SIGTERM and SIGKILL. */
const CLOSE_GRACE_MS = 5_000;

/** What a session wants from the connection it shares. */
export interface DeepSeekSessionHandler {
  /** One `session/update` notification bound for this session. */
  update(notification: SessionNotification): void;
  /** The harness is asking the user to allow or refuse a tool call. */
  permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

/** What the driver is told about a process, whichever sessions it serves. */
export interface DeepSeekProcessEvents {
  /** The process is gone: every session it served has ended. */
  ended(sessionIds: readonly string[], error: string): void;
  /** The harness's model asked the user something (the plugin pushes it on
   *  stderr, the one stream that is not the protocol's). */
  question?(line: string): void;
}

/** One live harness process. */
export interface DeepSeekProcess {
  readonly client: AcpClient;
  /** What the harness said it implements, from `initialize`. */
  readonly capabilities: NonNullable<InitializeResponse['agentCapabilities']>;
  readonly pid: number | undefined;
  /** Where this process's CodeDeck plugin answers (plugin.ts): its own, so
   *  a session asks the process that holds it. */
  readonly bridgeSocket: string;
  /** The driver's configuration version as it was when this process
   *  started: a change since is configuration this process has not loaded. */
  readonly configVersion: number;
  /** MCP servers the harness has complained about since it started, by name
   *  — the one failure signal ACP does not carry. */
  mcpFailures(): ReadonlyMap<string, string>;
  /** Whether the process can still serve a session. */
  readonly alive: boolean;
  /** Take the messages of one session. */
  attach(sessionId: string, handler: DeepSeekSessionHandler): void;
  /** Stop taking them (the session is over). */
  detach(sessionId: string): void;
  /** Let go of this process: the runtime closes it once it was the last. */
  release(): void;
}

export interface DeepSeekRuntimeOptions {
  /** An operator-provided CLI entry point (a `dsh` they installed and want
   *  used, `CODEDECK_DEEPSEEK_PATH`); wins over the installed tree. */
  dshPath?: string;
  /** `$DSH_HOME` — the harness's state root. */
  home: string;
  cacheDir: string;
  registry?: string;
  log: (message: string) => void;
  /** Installs the runtime tree (install.ts). */
  installDsh: (options: { cacheDir: string; registry?: string; log: (message: string) => void }) => Promise<string>;
  /** Spawn seam for tests. */
  spawnFn?: SpawnFn;
  /** A counter that changes when the configuration a process loads
   *  changes, read at each spawn. The runtime does not know what that
   *  configuration is; the driver that owns it does. */
  configVersion?: () => number;
  /** How long a process outlives its last session (0 to close at once). */
  idleCloseMs?: number;
}

/** One environment's process, with the sessions using it. */
interface Context {
  readonly key: string;
  /** Settles with the live process, or rejects when it could not start. */
  opened: Promise<HarnessProcess>;
  /** Sessions that have acquired and not yet released it. */
  sessions: number;
  /** Every session let go and the process is on its way out: a new session
   *  needs a new one. */
  closing: boolean;
  /** The idle close waiting to happen. */
  timer?: NodeJS.Timeout;
  /** The process, once it is up. */
  live?: HarnessProcess;
}

/** `$DSH_HOME`: the operator's override, else a `dsh` beside the installed
 *  agent binaries (the bridge passes its own home, so this follows it). */
export function dshHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEDECK_DEEPSEEK_HOME?.trim() || path.join(path.dirname(agentCacheDir(env)), 'dsh');
}

/** The harness's profile directory, where its own configuration lives. */
export function dshProfileDir(home: string, profile: string = DSH_PROFILE): string {
  return path.join(home, 'profiles', profile);
}

/**
 * How to run the harness's CLI: an operator's own entry point may be a
 * directory's `bin.js` (this host runs it with its own node) or an executable
 * of their own, which is run as it stands. Never through a shell: the
 * arguments a session contributes are never shell syntax.
 */
export function dshCommand(entry: string, args: string[]): { command: string; args: string[] } {
  return /\.[cm]?js$/i.test(entry) ? { command: process.execPath, args: [entry, ...args] } : { command: entry, args };
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
class HarnessProcess implements DeepSeekProcess {
  /** What the harness answered `initialize` with; filled in by the runtime
   *  before the process is handed to a session. */
  capabilities: NonNullable<InitializeResponse['agentCapabilities']> = {};
  readonly configVersion: number;
  private readonly handlers = new Map<string, DeepSeekSessionHandler>();
  private readonly failures = new Map<string, string>();
  private readonly decoder = new StringDecoder('utf8');
  private stderrBuffer = '';
  private gone = false;

  constructor(
    private readonly child: ChildProcess,
    readonly client: AcpClient,
    configVersion: number,
    readonly bridgeSocket: string,
    private readonly hooks: {
      log: (message: string) => void;
      question: (line: string) => void;
      gone: (process_: HarnessProcess) => void;
      release: (process_: HarnessProcess) => void;
      ended: (sessionIds: readonly string[], error: string) => void;
    },
  ) {
    this.configVersion = configVersion;
    this.client.on('session/update', (notification) => {
      const handler = this.handlers.get(notification.sessionId);
      if (handler) handler.update(notification);
      else hooks.log(`[deepseek] dropped an update for unknown session ${notification.sessionId}`);
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

    // The harness logs its own diagnostics on stderr (ACP owns stdout). A
    // failed MCP server is only visible there, so those lines are read as a
    // status signal as well as passed to the host's log.
    child.stderr?.on('data', (chunk: Buffer) => this.readStderr(chunk));
    child.on('error', (error) => {
      hooks.log(`[deepseek] could not start the harness: ${error.message}`);
      this.client.finish({ error: error.message });
    });
    child.on('exit', (code, signal) => {
      // The plugin removes its socket as it closes; a process that was killed
      // never got to, and the path is nobody's now.
      if (process.platform !== 'win32') rmSync(bridgeSocket, { force: true });
      this.client.finish({ error: `the DeepSeek Harness process exited (${signal ? `signal ${signal}` : `code ${code ?? '?'}`})` });
    });
    void this.client.closed.then((closed) => {
      if (this.gone) return;
      this.gone = true;
      const sessionIds = [...this.handlers.keys()];
      this.handlers.clear();
      hooks.gone(this);
      const error = closed.error ?? 'the DeepSeek Harness process was closed';
      hooks.log(`[deepseek] the harness process is gone: ${error}`);
      hooks.ended(sessionIds, error);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.gone && this.client.isOpen;
  }

  mcpFailures(): ReadonlyMap<string, string> {
    return this.failures;
  }

  attach(sessionId: string, handler: DeepSeekSessionHandler): void {
    this.handlers.set(sessionId, handler);
  }

  detach(sessionId: string): void {
    this.handlers.delete(sessionId);
  }

  release(): void {
    this.hooks.release(this);
  }

  /** A clean shutdown: SIGTERM, then SIGKILL if the harness does not go. */
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
      // A question this bridge is asked to carry is the driver's, not the
      // log's: the plugin pushes it here because stdout belongs to ACP.
      if (line.includes(QUESTION_MARKER)) {
        this.hooks.question(line);
        continue;
      }
      this.hooks.log(`[deepseek] ${line}`);
      const failure = MCP_FAILURE.exec(line);
      if (failure?.[1] !== undefined) this.failures.set(failure[1], line);
    }
  }
}

export class DeepSeekRuntime {
  private readonly contexts = new Map<string, Context>();
  private readonly log: (message: string) => void;
  private entry: Promise<string> | null = null;
  private stopping = false;

  constructor(private readonly options: DeepSeekRuntimeOptions) {
    this.log = options.log;
  }

  /** The connection for one session's environment, started on first use. */
  async acquire(env: Record<string, string>, events: DeepSeekProcessEvents): Promise<DeepSeekProcess> {
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

  /**
   * Resolve the runtime now — installing it when the machine has none — so a
   * session that comes later does not wait for the download. A failure is
   * only logged: the next session asks again, and reports it then.
   */
  async prepare(): Promise<void> {
    try {
      await this.entryPoint();
    } catch (error) {
      this.log(`[deepseek] the DeepSeek Harness runtime is not ready yet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The runtime's own `node_modules`: every `@deepseek-ai/*` package the
   * harness ships resolves from here, which is where a shipped bundle's
   * version is found (a profile installs only what a user added).
   */
  async packagesRoot(): Promise<string | undefined> {
    let file = await this.entryPoint();
    for (let depth = 0; depth < 8; depth++) {
      const dir = path.dirname(file);
      if (dir === file) break;
      if (path.basename(dir) === 'node_modules') return dir;
      file = dir;
    }
    return undefined;
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
    this.entry = null;
  }

  /** The context for one key: the live one while it can still serve, else a
   *  fresh process. */
  private open(key: string, env: Record<string, string>, events: DeepSeekProcessEvents): Context {
    const existing = this.contexts.get(key);
    if (existing && !existing.closing && (existing.live === undefined || existing.live.alive)) {
      if (existing.timer) {
        clearTimeout(existing.timer);
        existing.timer = undefined;
      }
      return existing;
    }
    const context: Context = { key, opened: undefined as never, sessions: 0, closing: false };
    this.contexts.set(key, context);
    context.opened = this.spawn(context, env, events);
    return context;
  }

  private async spawn(context: Context, env: Record<string, string>, events: DeepSeekProcessEvents): Promise<HarnessProcess> {
    const entry = await this.entryPoint();
    // The harness's state root is the driver's to set, never the session's:
    // a session that moved it would lose the conversation it is resuming.
    const command = dshCommand(entry, ['--profile', DSH_PROFILE]);
    // Not part of the environment's identity (envKeyOf): it names this one
    // process, whichever sessions share it.
    const bridgeSocket = bridgeSocketPath(this.options.home, randomBytes(6).toString('hex'));
    const child = (this.options.spawnFn ?? spawn)(command.command, command.args, {
      env: { ...env, DSH_HOME: this.options.home, [BRIDGE_SOCKET_ENV]: bridgeSocket },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const process_ = new HarnessProcess(
      child,
      new AcpClient({ stdin: child.stdin!, stdout: child.stdout!, log: this.log }),
      this.options.configVersion?.() ?? 0,
      bridgeSocket,
      {
        log: this.log,
        question: (line) => events.question?.(line),
        gone: (gone) => this.forget(context.key, context, gone),
        release: (released) => this.release(context, released),
        ended: (sessionIds, error) => events.ended(sessionIds, error),
      },
    );
    // The connection is initialized before any session uses it: the harness
    // answers with what it implements, and a profile that cannot boot fails
    // here rather than on the first prompt.
    try {
      const initialized = await process_.client.request(
        'initialize',
        { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
        { timeoutMs: INITIALIZE_TIMEOUT_MS },
      );
      process_.capabilities = initialized.agentCapabilities ?? {};
    } catch (error) {
      process_.client.finish({ error: 'the harness did not initialize' });
      await process_.close();
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (this.stopping || context.closing) {
      await process_.close();
      throw new Error('the agent host is shutting down');
    }
    context.live = process_;
    this.log(`[deepseek] started ${DSH_LABEL} (pid ${child.pid ?? '?'}, profile ${DSH_PROFILE})`);
    return process_;
  }

  /** The CLI entry point: the operator's own, else the installed tree. */
  entryPoint(): Promise<string> {
    if (this.options.dshPath) {
      const explicit = this.options.dshPath;
      if (!isFile(explicit)) return Promise.reject(new Error(`CODEDECK_DEEPSEEK_PATH points at ${explicit}, which is not a file`));
      return Promise.resolve(explicit);
    }
    this.entry ??= this.options
      .installDsh({
        cacheDir: this.options.cacheDir,
        ...(this.options.registry !== undefined ? { registry: this.options.registry } : {}),
        log: this.log,
      })
      .catch((error: unknown) => {
        // A download that failed is attempted again by the next session
        // rather than remembered as this driver's permanent state.
        this.entry = null;
        throw error;
      });
    return this.entry;
  }

  /** A process went away: it is no longer this environment's process, and
   *  the next session starts a new one. */
  private forget(key: string, context: Context, process_?: HarnessProcess): void {
    const current = this.contexts.get(key);
    if (current !== context) return;
    if (process_ && current.live && current.live !== process_) return;
    if (current.timer) clearTimeout(current.timer);
    this.contexts.delete(key);
  }

  /** One session let go: close the process once nobody is using it, after a
   *  grace period so a bridge restart does not pay a boot per session. */
  private async release(context: Context, process_: HarnessProcess): Promise<void> {
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

  private async closeIdle(context: Context): Promise<void> {
    context.timer = undefined;
    // A session that arrived while the timer ran keeps the process.
    if (context.sessions > 0 || this.contexts.get(context.key) !== context) return;
    context.closing = true;
    this.forget(context.key, context);
    this.log('[deepseek] closing the idle harness process');
    await context.live?.close();
  }
}
