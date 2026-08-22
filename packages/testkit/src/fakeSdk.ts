/**
 * FakeSdkFacade — a scriptable in-memory implementation of @codedeck/core's
 * SdkFacade for contract tests. No subprocess, no real SDK.
 *
 * - `emit(sessionId, msg)` pushes an SDK message into that session's
 *   messages() stream (what the real Claude Code subprocess would produce).
 * - Pushed input, mode/model/effort changes, and interrupts are recorded on
 *   the session handle for assertions.
 * - The `canUseTool` callback passed at creation is exposed so tests can
 *   trigger permission flows exactly as the SDK would.
 */
import { isProviderBoundSession } from '@codedeck/core';
import type {
  SdkCanUseTool,
  SdkContextUsage,
  SdkFacade,
  SdkMessage,
  SdkModelDescriptor,
  SdkSessionHandle,
  SdkSessionOptions,
} from '@codedeck/core';
import type { EffortLevel, PermissionMode } from '@codedeck/protocol';

export class FakeSdkSession implements SdkSessionHandle {
  readonly options: SdkSessionOptions;

  /** Recorded pushInput() texts, in order. */
  readonly inputs: string[] = [];
  /** Recorded setPermissionMode() calls, in order. */
  readonly modes: PermissionMode[] = [];
  /** Recorded setModel() calls, in order. */
  readonly models: string[] = [];
  /** Recorded setEffort() calls, in order. */
  readonly efforts: EffortLevel[] = [];
  /** Number of interrupt() calls. */
  interrupts = 0;
  /** True after end(). */
  ended = false;

  /** Script what getContextUsage()/getUsageSnapshot() resolve to. */
  contextUsage: SdkContextUsage | null = null;
  usageSnapshot: unknown | null = null;

  private queue: SdkMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private streamError: unknown = null;

  constructor(options: SdkSessionOptions) {
    this.options = options;
  }

  /** The canUseTool callback the core wired in — call it to simulate the SDK
   *  asking for permission. */
  get canUseTool(): SdkCanUseTool {
    return this.options.canUseTool;
  }

  /** Script a message into the stream (what the subprocess would emit). */
  emit(msg: SdkMessage): void {
    this.queue.push(msg);
    this.wake?.();
  }

  /** End the message stream (subprocess exit) without marking the handle ended. */
  closeStream(): void {
    this.closed = true;
    this.wake?.();
  }

  /** Error the message stream (subprocess crash / dead resume) — what the real
   *  SDK does for e.g. "No conversation found with session ID …". Drives the
   *  runner's handleStreamError restart path. */
  errorStream(err: unknown): void {
    this.streamError = err;
    this.wake?.();
  }

  async *messages(): AsyncIterable<SdkMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.streamError !== null) throw this.streamError;
      if (this.closed) return;
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
  }

  pushInput(text: string): void {
    this.inputs.push(text);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.modes.push(mode);
  }

  async setModel(model: string): Promise<void> {
    this.models.push(model);
  }

  async setEffort(level: EffortLevel): Promise<void> {
    this.efforts.push(level);
  }

  async interrupt(): Promise<void> {
    this.interrupts++;
  }

  // --- probeReady scripting ---
  // Default: the probe never settles, so tests that flip ready via an emitted
  // `init` message keep their exact pre-probe semantics (deterministic
  // ordering). Real-SDK behavior: resolves ~1s after spawn, rejects fast on a
  // broken executable — script it with confirmProbe()/failProbe().
  private probeMode: 'hang' | 'ok' | { error: unknown } = 'hang';
  private probeWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];

  probeReady(): Promise<void> {
    if (this.probeMode === 'ok') return Promise.resolve();
    if (typeof this.probeMode === 'object') return Promise.reject(this.probeMode.error);
    return new Promise<void>((resolve, reject) => {
      this.probeWaiters.push({ resolve, reject });
    });
  }

  /** Resolve pending (and all future) probeReady() calls — a live CLI. */
  confirmProbe(): void {
    this.probeMode = 'ok';
    const waiters = this.probeWaiters.splice(0);
    for (const w of waiters) w.resolve();
  }

  /** Reject pending (and all future) probeReady() calls — spawn failure. */
  failProbe(error: unknown): void {
    this.probeMode = { error };
    const waiters = this.probeWaiters.splice(0);
    for (const w of waiters) w.reject(error);
  }

  async getContextUsage(): Promise<SdkContextUsage | null> {
    return this.contextUsage;
  }

  async getUsageSnapshot(): Promise<unknown | null> {
    return this.usageSnapshot;
  }

  async end(): Promise<void> {
    this.ended = true;
    this.closeStream();
  }
}

export class FakeSdkFacade implements SdkFacade {
  /** All sessions ever created, keyed by sessionId. */
  readonly sessions = new Map<string, FakeSdkSession>();
  /** What supportedModels() resolves to. */
  models: SdkModelDescriptor[] = [];

  createSession(opts: SdkSessionOptions): SdkSessionHandle {
    const session = new FakeSdkSession(opts);
    this.sessions.set(opts.sessionId, session);
    return session;
  }

  async supportedModels(): Promise<SdkModelDescriptor[]> {
    // CDX-062: mirror RealSdkFacade's guard — a provider-bound handle never
    // answers the machine-wide Anthropic model list. When every live handle is
    // provider-bound there is nothing to ask: return [] like the real facade.
    //
    // CDX-071: the predicate is IMPORTED from core, not restated here. The old
    // copy tested `!!s.options.env?.ANTHROPIC_BASE_URL` — the very env sniffing
    // the real facade dropped, because that var in the bridge OPERATOR'S own
    // shell is a documented LLM-gateway setup and every session inherits it, so
    // the rule flagged plain Anthropic sessions and emptied the phone's model
    // list (CDX-022's symptom). A double that keeps a rule production has
    // retired cannot fail on the regression it exists to catch, so the two must
    // read the same function — see the agreement test in fakeSdk.test.ts.
    const live = [...this.sessions.values()].filter((s) => !s.ended);
    if (live.length > 0 && live.every((s) => isProviderBoundSession(s.options))) {
      return [];
    }
    return this.models;
  }

  /** Script a message into a session's stream. Throws on unknown session. */
  emit(sessionId: string, msg: SdkMessage): void {
    this.session(sessionId).emit(msg);
  }

  /** The canUseTool callback core wired into a session. */
  canUseTool(sessionId: string): SdkCanUseTool {
    return this.session(sessionId).canUseTool;
  }

  session(sessionId: string): FakeSdkSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`FakeSdkFacade: unknown session ${sessionId}`);
    return s;
  }
}
