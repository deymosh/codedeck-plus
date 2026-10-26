/**
 * The ACP session base: one ACP session inside a shared process, with the
 * lifecycle every ACP agent's driver needs — start (or resume) it, prompt it
 * one turn at a time, cancel, change a config option, close it — and the
 * dispatch of the updates and permission asks the process sends back.
 *
 * Everything an agent does differently enters through the abstract members:
 * the environment a session's process runs in, how its tool calls read, how a
 * permission ask becomes a card on the phone, its modes and its model and
 * effort selection. What the base keeps is what ACP itself fixes: one prompt
 * at a time, `session/new` or `session/resume`, the context meter, the turn
 * markers, and the rule that an ask nobody answers is not a refusal.
 */
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { DriverSession, SessionContext } from '../sdk/driver';
import { PERMISSION_ALLOW, PERMISSION_DENY, now, unknownToolReporter } from '../sdk/tools';
import type { OutputEntry, PermissionRequest, SessionOption, StartSession, UsageData } from '../sdk/types';
import type { ToolCallMemory } from './adapter';
import type { AcpClient } from './acp';
import type { AcpProcess, AcpProcessEvents, AcpRuntime } from './runtime';

/** Where a running session registers, so the driver can end it when the
 *  process it shares goes away. */
export interface AcpSessionRegistry<H, E extends AcpProcessEvents> {
  add(sessionId: string, session: AcpSession<H, E, AcpSessionDeps<H, E>>): void;
  remove(sessionId: string): void;
  events(): E;
}

/** What one session is built with, beyond its own parameters. */
export interface AcpSessionDeps<H, E extends AcpProcessEvents> {
  /** The runtime that owns the agent's processes. */
  runtime: AcpRuntime<H, E>;
  /** Where this session is registered while it runs. */
  live: AcpSessionRegistry<H, E>;
  /** Everything that must be true of the agent before a process starts. */
  prepared: Promise<unknown>;
  /** The tag this session's log lines carry. */
  tag: string;
  /** How this agent reads in the notices and errors a person sees. */
  label: string;
}

/** How long a session-lifecycle request (`session/new`, `session/resume`,
 *  `session/close`) may wait for the agent. A turn takes as long as the model
 *  takes, but opening or closing a session has no work that should outlast
 *  this: a wedged agent must not block a start, an end-session, or the host's
 *  shutdown for ever. */
export const SESSION_REQUEST_TIMEOUT_MS = 15_000;

/** After `session/cancel`, how long the prompt may stay unsettled before the
 *  turn is ended here anyway: an agent that ignores the cancel must not keep
 *  the phone showing a turn that will never finish. */
export const CANCEL_GRACE_MS = 10_000;

type PendingAsk = (response: RequestPermissionResponse) => void;

export abstract class AcpSession<
  H,
  E extends AcpProcessEvents,
  D extends AcpSessionDeps<H, E> = AcpSessionDeps<H, E>,
> implements DriverSession {
  /** What each tool call's own update carried, for its result and for the
   *  permission card the agent asks about it. */
  protected readonly calls: ToolCallMemory = new Map();
  /** Told a tool name no agent's table lists, which the log then carries. */
  protected readonly reportUnknownTool: (toolName: string) => void;
  protected readonly cwd: string;
  protected readonly env: Record<string, string>;
  protected readonly ready: Promise<void>;
  protected process?: AcpProcess<H>;
  protected nativeId?: string;
  protected options: SessionConfigOption[] = [];
  /** The session's modes and the one it is in, as the agent reported them.
   *  An agent with no modes leaves this undefined. */
  private modes?: SessionModeState;
  private contextPercentage?: number;
  private contextWindow?: number;
  /** Whether the phone has been told the session is up: until then its model
   *  travels in the identity info, not as a change. */
  protected announced = false;
  protected ended = false;
  /** Prompts run one at a time: ACP refuses a second prompt while one is in
   *  flight, so a message that cannot steer the running turn waits for it. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Whether a `session/prompt` of this session is in flight — the turn a
   *  message sent now can steer. */
  protected promptInFlight = false;
  /** Permission asks the agent is waiting on. A session that ends settles
   *  them as cancelled, so the agent is never left waiting on a decision no
   *  person can still give (and its `session/close` is not blocked on one). */
  private readonly pendingAsks = new Set<PendingAsk>();
  /** Whether a turn this session opened is still open: an interrupt may end
   *  it here, and its prompt settling later must not end it a second time. */
  private turnOpen = false;
  /** The cancel grace waiting to end a turn the agent did not settle. */
  private cancelTimer?: NodeJS.Timeout;
  /** Settles `runPrompt`'s wait when an interrupt abandons the running
   *  prompt: the agent never answers that request, and the chain behind it
   *  must still advance to the next message. */
  private abandonPrompt?: () => void;

  constructor(
    protected readonly params: StartSession,
    protected readonly ctx: SessionContext,
    protected readonly deps: D,
  ) {
    this.cwd = params.cwd;
    this.reportUnknownTool = unknownToolReporter((message) => ctx.log(message));
    this.env = this.buildEnv(params);
    this.ready = this.init();
    // init() reports its own failure as `ended`; nothing else awaits this
    // rejection except prompt/interrupt, which catch it themselves.
    this.ready.catch(() => {});
  }

  // --- what the agent does differently ---

  /** The environment one session's process runs in. */
  protected abstract buildEnv(params: StartSession): Record<string, string>;

  /** Translate one `session/update` into the entries it shows on the phone. */
  protected abstract translate(update: SessionUpdate, calls: ToolCallMemory): OutputEntry[];

  /** Whether the session's mode allows every permission ask without asking. */
  protected abstract autoApprove(): boolean;

  /** The card one permission ask becomes on the phone. */
  protected abstract permissionCard(request: RequestPermissionRequest): Omit<PermissionRequest, 'sessionId'>;

  /** Apply the model and reasoning level the session was started with. */
  protected abstract applySelection(): Promise<void>;

  /** The mode the session runs in, as the identity info reports it. */
  protected abstract mode(): string;

  /** The model the session is on, as the identity info reports it. */
  protected abstract modelLabel(): string | undefined;

  /** The agent's own version, for the opening status line. */
  protected abstract version(): Promise<string | undefined>;

  /** Run a slash line this session knows as the agent's own command, and say
   *  whether it was one (else the line is an ordinary prompt). */
  protected async tryCommand(text: string): Promise<boolean> {
    void text;
    return false;
  }

  /** A message sent while a turn runs, which ACP cannot take as a second
   *  prompt. The default waits for the turn to end. */
  protected steer(text: string): void {
    this.enqueue(text);
  }

  /** Called once a `session/prompt` settles, however it ended, before the
   *  turn is marked complete: a driver whose messages can be steered into a
   *  running turn clears that state here. */
  protected promptSettled(): void {}

  // --- the lifecycle ---

  private async init(): Promise<void> {
    try {
      // The agent reads its configuration and mounts its plugins as it boots,
      // so both have to be in place before a process starts.
      await this.deps.prepared;
      const process_ = await this.deps.runtime.acquire(this.env, this.deps.live.events());
      this.process = process_;
      // A session closed while its process was starting keeps nothing: the
      // process it acquired is let go at once.
      if (this.ended) {
        this.abandon();
        return;
      }
      const opened = await this.openSession();
      this.nativeId = opened.sessionId;
      this.options = opened.configOptions;
      this.modes = opened.modes ?? undefined;
      if (this.ended) {
        this.abandon();
        return;
      }
      process_.attach(opened.sessionId, {
        update: (notification) => this.onUpdate(notification),
        permission: (request) => this.onPermission(request),
        extRequest: (method, params) => this.handleExtRequest(method, params),
      });
      this.deps.live.add(opened.sessionId, this);
      await this.applySelection();
      if (this.ended) return;
      const model = this.modelLabel();
      this.announced = true;
      this.ctx.emit({ type: 'info', nativeSessionId: opened.sessionId, ...(model ? { model } : {}), mode: this.mode() });
      // The version is said once, when a conversation starts — the model is
      // on the phone's composer. A resumed one said it when it began.
      if (!opened.resumed) {
        const version = await this.version();
        if (this.ended) return;
        this.deliver({
          entryType: 'status',
          text: version ? `${this.deps.label} ${version}` : `${this.deps.label} session started`,
          timestamp: now(),
        });
      }
      this.ctx.emit({ type: 'ready' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deliver({ entryType: 'error', text: message, timestamp: now() });
      this.finish(message);
    }
  }

  /** Start a fresh conversation, or continue the one the bridge names. A
   *  conversation the agent no longer has (removed, or started in another
   *  workspace — it checks) falls back to a fresh one with a notice, as the
   *  other drivers do: the transcript is the bridge's, the memory is the
   *  agent's. */
  private async openSession(): Promise<{
    sessionId: string;
    configOptions: SessionConfigOption[];
    modes?: SessionModeState | null;
    resumed: boolean;
  }> {
    const resume = this.params.resume;
    const resumable = this.process?.capabilities.sessionCapabilities?.resume;
    // ACP spells "not supported" both as an absent field and as `null`;
    // only an object (even an empty one) advertises `session/resume`.
    if (resume && resumable != null) {
      try {
        const resumed = await this.sessionRequest('session/resume', { sessionId: resume, cwd: this.cwd, mcpServers: [] });
        return { sessionId: resume, configOptions: resumed.configOptions ?? [], modes: resumed.modes, resumed: true };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.ctx.log(`[${this.deps.tag}] could not resume ${resume} (${reason}) — starting a fresh session`);
        this.deliverResumeLost();
      }
    } else if (resume) {
      // The agent cannot continue a conversation at all. The bridge asked
      // for one, so the fresh session it gets instead is not a silent swap:
      // the model has not seen the earlier turns.
      this.ctx.log(`[${this.deps.tag}] cannot resume ${resume}: the agent offers no session/resume — starting a fresh session`);
      this.deliverResumeLost();
    }
    const created = await this.sessionRequest('session/new', { cwd: this.cwd, mcpServers: [] });
    return { sessionId: created.sessionId, configOptions: created.configOptions ?? [], modes: created.modes, resumed: false };
  }

  /**
   * A `session/new` or `session/resume` with a deadline. A reply that
   * arrives after the deadline is not necessarily worthless: an agent that
   * created the session late leaves it behind, and the next session this
   * driver opens would not own it. A late answer that names a session is
   * therefore closed, best effort.
   */
  private sessionRequest(
    method: 'session/new',
    params: { cwd: string; mcpServers: [] },
  ): Promise<{ sessionId: string; configOptions?: SessionConfigOption[]; modes?: SessionModeState | null }>;
  private sessionRequest(
    method: 'session/resume',
    params: { sessionId: string; cwd: string; mcpServers: [] },
  ): Promise<{ configOptions?: SessionConfigOption[]; modes?: SessionModeState | null }>;
  private async sessionRequest(
    method: 'session/new' | 'session/resume',
    params: { sessionId?: string; cwd: string; mcpServers: [] },
  ): Promise<unknown> {
    const client = this.client;
    const request =
      method === 'session/new'
        ? client.request('session/new', params as { cwd: string; mcpServers: [] })
        : client.request('session/resume', params as { sessionId: string; cwd: string; mcpServers: [] });
    let timedOut = false;
    void request.then(
      (result) => {
        if (!timedOut) return;
        const sessionId = (result as { sessionId?: unknown } | null)?.sessionId;
        if (typeof sessionId === 'string' && sessionId !== '') this.closeOrphanSession(client, sessionId);
      },
      () => {},
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`${method} did not answer within ${SESSION_REQUEST_TIMEOUT_MS}ms`));
          }, SESSION_REQUEST_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Close a session the agent created after its start was given up on. The
   *  connection may be gone by now, so this is best effort. */
  private closeOrphanSession(client: AcpClient, sessionId: string): void {
    this.ctx.log(`[${this.deps.tag}] closing ${sessionId}: its start had already timed out`);
    void client.request('session/close', { sessionId }, { timeoutMs: SESSION_REQUEST_TIMEOUT_MS }).catch(() => {});
  }

  /** Say that the conversation asked for could not be continued: the person
   *  has to know the model will not remember earlier turns. */
  private deliverResumeLost(): void {
    this.deliver({
      entryType: 'notice',
      kind: 'session_restart',
      text:
        `${this.deps.label} could not continue this conversation — starting a fresh one in the same workspace. ` +
        'The transcript is preserved, but the model does not remember earlier turns.',
      timestamp: now(),
    });
  }

  /** The process this session shares went away, taking the session with it. */
  endFromProcess(error: string): void {
    this.finish(error);
  }

  /** One update of this session: entries for the transcript, and the two
   *  updates that are session state rather than conversation. */
  private onUpdate(notification: SessionNotification): void {
    if (this.ended) return;
    const update = notification.update;
    if (update.sessionUpdate === 'usage_update') {
      this.reportContext(update.used, update.size);
      return;
    }
    if (update.sessionUpdate === 'config_option_update') {
      this.options = update.configOptions;
      return;
    }
    if (update.sessionUpdate === 'current_mode_update') {
      this.onModeChanged(update.currentModeId);
      return;
    }
    const entries = this.translate(update, this.calls);
    if (entries.length > 0) this.ctx.emit({ type: 'entries', entries });
  }

  /** The agent switched its own mode (leaving plan mode after an approval,
   *  its own `/mode`, a classifier). The phone is told; a driver that keeps
   *  its own mode state updates it in `modeChanged`. */
  private onModeChanged(modeId: string): void {
    if (this.modes) this.modes = { ...this.modes, currentModeId: modeId };
    this.modeChanged(modeId);
    if (this.announced) this.ctx.emit({ type: 'info', mode: modeId });
  }

  /** Called when the agent changes its own mode. The default does nothing. */
  protected modeChanged(modeId: string): void {
    void modeId;
  }

  /** The session's modes, as the agent reported them. */
  protected modeState(): SessionModeState | undefined {
    return this.modes;
  }

  /**
   * Switch the session's mode with the agent's own `session/set_mode`, the
   * one call ACP defines for it (an agent that also offers a `mode` config
   * option takes that, but the method is what every agent with modes has).
   * The new mode is kept so the next reader sees it.
   */
  protected async setMode(modeId: string): Promise<void> {
    const sessionId = this.nativeId;
    if (!sessionId) throw new Error('the session has not started');
    await this.client.request('session/set_mode', { sessionId, modeId });
    if (this.modes) this.modes = { ...this.modes, currentModeId: modeId };
  }

  /**
   * An extension request the agent sent for this session (a method ACP does
   * not define). The default claims none, so such a request is answered with
   * `-32601` at once — which is what a driver that does not know the method
   * wants, and what the agent reads as "not supported".
   */
  protected async handleExtRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    void method;
    void params;
    return undefined;
  }

  /** How full the context is, over the window the agent reports. */
  private reportContext(used: number, size: number): void {
    if (!(size > 0) || !Number.isFinite(used)) return;
    const percentage = Math.max(0, Math.min(100, Math.round((used / size) * 100)));
    if (percentage === this.contextPercentage && size === this.contextWindow) return;
    this.contextPercentage = percentage;
    this.contextWindow = size;
    this.ctx.emit({ type: 'info', contextWindow: size, contextPercentage: percentage });
  }

  /**
   * One permission ask, as `answerPermission` answers it — but always
   * answerable: when the session ends while the person is still deciding,
   * the ask is settled as cancelled rather than left pending.
   */
  private onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return new Promise<RequestPermissionResponse>((resolve) => {
      let settled = false;
      const settle: PendingAsk = (response) => {
        if (settled) return;
        settled = true;
        this.pendingAsks.delete(settle);
        resolve(response);
      };
      this.pendingAsks.add(settle);
      void this.answerPermission(request).then(settle, () => settle({ outcome: { outcome: 'cancelled' } }));
    });
  }

  /** Answer every ask the session can no longer pass to a person. */
  private cancelPendingAsks(): void {
    for (const settle of [...this.pendingAsks]) settle({ outcome: { outcome: 'cancelled' } });
  }

  /**
   * One permission ask. The choices are the two the agent offers — it may
   * have no "always allow" to choose — and the card is the driver's, since
   * only it knows what the call is.
   *
   * A driver whose ask carries more than a yes/no overrides this: Qwen Code
   * routes its question form and its plan review through the same method,
   * and each needs a reply shaped like itself (the question's answers beside
   * the outcome, the plan's own verdict).
   */
  protected async answerPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const allow = request.options.find((option) => option.kind === 'allow_once');
    const reject = request.options.find((option) => option.kind === 'reject_once');
    const refuse = (): RequestPermissionResponse =>
      reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
    if (this.ended || !allow) return { outcome: { outcome: 'cancelled' } };
    if (this.autoApprove()) return { outcome: { outcome: 'selected', optionId: allow.optionId } };

    const outcome = await this.ctx.requestPermission(this.permissionCard(request));
    if (outcome.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } };
    return outcome.optionId === PERMISSION_ALLOW.id ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : refuse();
  }

  protected deliver(entry: OutputEntry): void {
    this.ctx.emit({ type: 'entries', entries: [entry] });
  }

  protected finish(error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.turnOpen = false;
    this.clearCancelGrace();
    this.cancelPendingAsks();
    this.abandon();
    this.ctx.emit({ type: 'ended', ...(error ? { error } : {}) });
  }

  /** Let go of the process this session held. */
  protected abandon(): void {
    const process_ = this.process;
    this.process = undefined;
    if (this.nativeId !== undefined) {
      process_?.detach(this.nativeId);
      this.deps.live.remove(this.nativeId);
    }
    process_?.release();
  }

  /**
   * One message from the user. While a turn runs, ACP takes no second prompt,
   * so a message is handed to that turn instead when the driver can steer it,
   * and waits for the turn to end otherwise.
   */
  prompt(text: string): void {
    if (this.promptInFlight) {
      this.steer(text);
      return;
    }
    this.enqueue(text);
  }

  protected enqueue(text: string): void {
    const next = this.tail.then(
      () => this.runPrompt(text),
      () => this.runPrompt(text),
    );
    this.tail = next.catch(() => {});
  }

  private async runPrompt(text: string): Promise<void> {
    if (await this.tryCommand(text)) return;
    try {
      await this.ready;
      const sessionId = this.nativeId;
      if (this.ended || sessionId === undefined) return;
      this.ctx.emit({ type: 'turn', state: 'running' });
      this.promptInFlight = true;
      this.turnOpen = true;
      const request = this.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      // A refusal that arrives after the prompt was abandoned is no longer
      // this turn's to report.
      request.catch(() => {});
      let abandon!: () => void;
      const abandoned = new Promise<void>((resolve) => (abandon = resolve));
      this.abandonPrompt = abandon;
      try {
        await Promise.race([request, abandoned]);
      } finally {
        this.abandonPrompt = undefined;
        this.promptInFlight = false;
        this.clearCancelGrace();
        this.promptSettled();
      }
      // A turn an interrupt already ended here is not ended again.
      if (this.turnOpen) this.endTurn();
    } catch (error) {
      if (this.ended) return;
      this.deliver({ entryType: 'error', text: error instanceof Error ? error.message : String(error), timestamp: now() });
      if (this.turnOpen) this.endTurn();
    }
  }

  /** The turn is over: the transcript marks it and the phone stops showing
   *  the agent as working. Every ending is one of these — a cancelled turn
   *  and a failed one end the turn too. */
  protected endTurn(): void {
    if (this.ended) return;
    this.turnOpen = false;
    this.clearCancelGrace();
    this.deliver({ entryType: 'turn_complete', timestamp: now() });
    this.ctx.emit({ type: 'turn', state: 'idle' });
  }

  async interrupt(): Promise<void> {
    const sessionId = this.nativeId;
    if (sessionId === undefined || this.ended) return;
    // Best effort: an already-idle session has nothing to cancel.
    try {
      this.client.notify('session/cancel', { sessionId });
    } catch {
      // The connection is gone; `ended` has already said so.
      return;
    }
    if (!this.promptInFlight) return;
    // An agent may ignore the cancel; the turn then ends here after the
    // grace, so the phone is not left showing it as running for ever.
    this.clearCancelGrace();
    this.cancelTimer = setTimeout(() => this.abandonTurn(), CANCEL_GRACE_MS);
    this.cancelTimer.unref?.();
  }

  /** The agent did not settle its turn after a cancel: end it here, saying
   *  so. Its prompt may still settle later; that then ends nothing twice. */
  private abandonTurn(): void {
    this.cancelTimer = undefined;
    if (this.ended || !this.promptInFlight) return;
    this.promptInFlight = false;
    // Stop waiting on the request the agent never answered, so the prompt
    // chain advances and the next message runs (a second interrupt would
    // otherwise be a no-op too).
    this.abandonPrompt?.();
    this.deliver({
      entryType: 'notice',
      kind: 'other',
      text: `${this.deps.label} did not confirm stopping the turn; it was ended here. It may still be finishing in the agent.`,
      timestamp: now(),
    });
    this.endTurn();
  }

  private clearCancelGrace(): void {
    if (this.cancelTimer === undefined) return;
    clearTimeout(this.cancelTimer);
    this.cancelTimer = undefined;
  }

  abstract setOption(option: SessionOption, value: string): Promise<void>;

  async getUsage(): Promise<UsageData | null> {
    // Nothing to ask for: ACP carries no subscription usage.
    return null;
  }

  async end(): Promise<void> {
    if (this.ended) return;
    const sessionId = this.nativeId;
    const process_ = this.process;
    this.ended = true;
    this.turnOpen = false;
    this.clearCancelGrace();
    this.cancelPendingAsks();
    if (sessionId !== undefined && process_) {
      // Closing the session lets the agent cancel its work and flush; the
      // conversation stays on disk for a later resume. Bounded, and skipped
      // once the agent is gone: a wedged process must not hold this open.
      await process_.client
        .request('session/close', { sessionId }, { timeoutMs: SESSION_REQUEST_TIMEOUT_MS })
        .catch(() => {});
    }
    this.abandon();
  }

  // --- shared plumbing ---

  protected get client(): AcpClient {
    const process_ = this.process;
    if (!process_) throw new Error('the session has not started');
    return process_.client;
  }

  protected optionOf(id: string): SessionConfigOption | undefined {
    return this.options.find((option) => option.id === id);
  }

  /** Change one option and keep the state that comes back — the agent answers
   *  every change with the complete option list. */
  protected async setConfig(configId: string, value: string): Promise<void> {
    const sessionId = this.nativeId;
    if (!sessionId) throw new Error('the session has not started');
    const result = await this.client.request('session/set_config_option', { sessionId, configId, value });
    this.options = result.configOptions ?? this.options;
  }
}
