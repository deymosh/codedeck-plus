/**
 * OpenCode backend over `@opencode-ai/sdk`, implementing the SAME `SdkFacade`
 * / `SdkSessionHandle` seam `RealSdkFacade`/`RealSdkSessionHandle` (facade.ts)
 * implement for Claude Code. Everything downstream of these two classes —
 * SessionRunner, PermissionBroker, the Nostr publish path — is unaware which
 * backend produced a session; only `bridge.ts`'s `makeRunner` picks this
 * facade over the Claude Code one, and only `opencodeAdapter.ts` (not this
 * file) knows OpenCode's own message/event shapes well enough to translate
 * them into OutputEntry objects.
 *
 * Like RealSdkFacade, this class is deliberately NOT unit-tested beyond the
 * pure translation function in opencodeAdapter.ts — its only meaningful test
 * would be talking to a real OpenCode server.
 *
 * Design choices deliberately kept minimal for this first pass (see the plan
 * this was built from):
 *  - Permission bridging is allow/deny only — no "always"/pattern rules, no
 *    doom-loop detection. See handlePermission below.
 *  - getContextUsage()/getUsageSnapshot() always return null — OpenCode has
 *    no equivalent control request to feature-detect, and fabricating a
 *    number would be worse than admitting we don't know.
 *  - setPermissionMode()/setEffort() are documented no-ops (see their doc
 *    comments) — OpenCode has no session-scoped analog for either.
 */
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import type {
  Event,
  OpencodeClient,
  Part,
  Permission,
  Session,
} from '@opencode-ai/sdk';
import type { EffortLevel, PermissionMode } from '@codedeck/protocol';
import type {
  SdkCanUseTool,
  SdkContextUsage,
  SdkFacade,
  SdkMessage,
  SdkModelDescriptor,
  SdkPermissionResult,
  SdkSessionHandle,
  SdkSessionOptions,
} from './facade';

export interface OpenCodeFacadeOptions {
  /**
   * External OpenCode server to talk to (`createOpencodeClient({ baseUrl })`).
   * When omitted, an embedded server is spawned lazily on first use via
   * `createOpencode()` and kept for the facade's lifetime. The bridge's own
   * wiring (apps/bridge/src/commands.ts) only ever uses the external-URL
   * mode, driven by `CODEDECK_OPENCODE_SERVER_URL` — never auto-spawning a
   * subprocess server on every bridge boot.
   */
  baseUrl?: string;
}

/** `model/providerID` split — OpenCode's prompt body wants `{providerID,
 *  modelID}`, not a single string. A phone-facing model id with no `/` (or
 *  an empty half) has no valid split, so the field is omitted entirely and
 *  OpenCode falls back to its own configured default — no fabrication. */
function splitModelId(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) return undefined;
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/** Best-effort human-readable text out of OpenCode's error-union shapes
 *  (ProviderAuthError / UnknownError / MessageOutputLengthError /
 *  MessageAbortedError / ApiError) without importing every member by name —
 *  all but one carry `data.message`; the odd one out (MessageOutputLengthError)
 *  falls back to its `name`. */
function formatOpenCodeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; data?: { message?: unknown } };
    if (typeof e.data?.message === 'string') return e.data.message;
    if (typeof e.name === 'string') return e.name;
  }
  return 'OpenCode reported an error';
}

/** Minimal SPSC async queue — the OpenCode counterpart of facade.ts's
 *  createInputChannel, generalized to output messages instead of input. */
class OpenCodeMessageQueue {
  private queue: SdkMessage[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(msg: SdkMessage): void {
    if (this.closed) return;
    this.queue.push(msg);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.();
  }

  async *drain(): AsyncGenerator<SdkMessage, void, unknown> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

class OpenCodeSessionHandle implements SdkSessionHandle {
  private readonly cwd: string;
  private readonly canUseTool: SdkCanUseTool;
  private readonly abortController = new AbortController();
  private readonly queue = new OpenCodeMessageQueue();
  private ended = false;
  private model?: { providerID: string; modelID: string };

  /** messageID -> role, seeded from message.updated events, so a later
   *  message.part.updated for the same messageID can be tagged — Part itself
   *  carries no role. Defaults to 'assistant' when unseen (the common case:
   *  the role event for a message reliably precedes its part events). */
  private readonly roles = new Map<string, 'user' | 'assistant'>();
  /** Text/reasoning part ids already emitted — each part is translated at
   *  most once, when it reaches a stable (non-streaming) state; see
   *  shouldEmitPart. */
  private readonly emittedPartIds = new Set<string>();
  /** Tool callIDs whose 'running' transition was already emitted, so a
   *  metadata-only update to a still-running call doesn't re-emit a second
   *  tool_use entry for the same call. */
  private readonly emittedToolRunning = new Set<string>();
  /** Permission ids already replied to — permission.updated could in theory
   *  refire; a second reply to an already-answered permission is rejected by
   *  the server anyway, but this avoids the wasted round trip and a second
   *  canUseTool call. */
  private readonly answeredPermissions = new Set<string>();

  /** Resolves once the OpenCode session exists server-side. probeReady()
   *  awaits this — the same "control-channel round trip" contract
   *  RealSdkSessionHandle's probeReady() has for Claude Code (see its doc
   *  comment in facade.ts): a fresh session confirms readiness before any
   *  init-shaped message is guaranteed to have arrived. */
  private readonly ready: Promise<{ client: OpencodeClient; session: Session }>;

  constructor(opts: SdkSessionOptions, clientPromise: Promise<OpencodeClient>) {
    this.cwd = opts.cwd;
    this.canUseTool = opts.canUseTool;
    this.model = splitModelId(opts.model);
    // Fire-and-forget: SdkFacade.createSession() must return synchronously,
    // with the actual server round trips happening in the background —
    // probeReady()/messages() are how a caller observes the outcome.
    this.ready = this.init(clientPromise, opts);
    this.ready.catch(() => {
      // init() already pushed an opencode-error entry into the queue on
      // failure; swallow the rejection here so it doesn't surface as an
      // unhandled promise rejection. probeReady() is the contract that
      // reports failure to the runner (it awaits this same promise).
    });
  }

  private async init(
    clientPromise: Promise<OpencodeClient>,
    opts: SdkSessionOptions,
  ): Promise<{ client: OpencodeClient; session: Session }> {
    const client = await clientPromise;
    // Subscribe BEFORE resolving/creating the session so no event in the gap
    // between "session exists" and "we started listening" is missed. The
    // stream is directory-scoped (a server can host multiple projects); this
    // handle further filters by sessionID once it is known.
    const { stream } = await client.event.subscribe({
      query: { directory: this.cwd },
      signal: this.abortController.signal,
    });

    let session: Session;
    try {
      session = await this.resolveSession(client, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.queue.push({ type: 'opencode-error', content: message } as unknown as SdkMessage);
      throw err;
    }

    this.queue.push({
      type: 'system',
      subtype: 'init',
      session_id: session.id,
      ...(opts.model ? { model: opts.model } : {}),
      permissionMode: opts.permissionMode,
    } as unknown as SdkMessage);

    // Consume the event stream for the rest of this handle's life. A stream
    // error (network drop, server restart) just ends the queue — the runner
    // reads that the same way it would read the message stream simply
    // ending.
    void this.consumeEvents(client, stream, session.id).catch(() => this.queue.close());

    return { client, session };
  }

  /** `opts.resume` names a previously seen OpenCode session id (round-tripped
   *  through SessionRegistry, same as Claude Code's sdkSessionId). Verify it
   *  still exists server-side before trusting it — a session the server no
   *  longer knows about (deleted, server restarted with no persistence) falls
   *  through to creating a fresh one rather than failing the whole session. */
  private async resolveSession(client: OpencodeClient, opts: SdkSessionOptions): Promise<Session> {
    if (opts.resume) {
      const { data, error } = await client.session.get({
        path: { id: opts.resume },
        query: { directory: this.cwd },
      });
      if (!error && data) return data;
    }
    const { data, error } = await client.session.create({
      query: { directory: this.cwd },
      body: { title: opts.sessionId },
    });
    if (error || !data) {
      throw new Error(`OpenCode session.create failed: ${JSON.stringify(error ?? 'no session returned')}`);
    }
    return data;
  }

  private async consumeEvents(
    client: OpencodeClient,
    // AsyncIterable, not the generator's exact 3-type-parameter shape: the SDK's
    // subscribe() return type resolves its generator's return-value type param
    // to `unknown` rather than `void`, and only `for await` iteration is needed
    // here, so the narrower, structurally-compatible type is correct too.
    stream: AsyncIterable<Event>,
    sessionId: string,
  ): Promise<void> {
    for await (const event of stream) {
      if (this.ended) break;
      switch (event.type) {
        case 'message.updated': {
          const info = event.properties.info;
          if (info.sessionID !== sessionId) continue;
          this.roles.set(info.id, info.role);
          if (info.role === 'assistant' && info.error) {
            this.queue.push({
              type: 'opencode-error',
              content: formatOpenCodeError(info.error),
            } as unknown as SdkMessage);
          }
          break;
        }
        case 'message.part.updated': {
          const part = event.properties.part;
          if (part.sessionID !== sessionId) continue;
          if (!this.shouldEmitPart(part)) continue;
          const role = this.roles.get(part.messageID) ?? 'assistant';
          this.queue.push({ type: 'opencode-part', part, role } as unknown as SdkMessage);
          break;
        }
        case 'session.idle': {
          if (event.properties.sessionID !== sessionId) continue;
          this.queue.push({
            type: 'system',
            subtype: 'session_state_changed',
            state: 'idle',
          } as unknown as SdkMessage);
          break;
        }
        case 'session.error': {
          if (event.properties.sessionID && event.properties.sessionID !== sessionId) continue;
          if (event.properties.error) {
            this.queue.push({
              type: 'opencode-error',
              content: formatOpenCodeError(event.properties.error),
            } as unknown as SdkMessage);
          }
          break;
        }
        case 'permission.updated': {
          const permission = event.properties;
          if (permission.sessionID !== sessionId) continue;
          this.handlePermission(client, permission);
          break;
        }
        default:
          break;
      }
    }
  }

  /** Deduplicates streaming updates into at-most-one OutputEntry-worthy
   *  translation per part, WITHOUT the pure opencodeAdapter.ts needing any
   *  state: text/reasoning parts only qualify once they stop changing (`time`
   *  absent — no timing info at all — or `time.end` set); a tool's 'running'
   *  transition is reported once per call, its terminal transition
   *  (completed/error) always reported. */
  private shouldEmitPart(part: Part): boolean {
    switch (part.type) {
      case 'text':
      case 'reasoning': {
        if (this.emittedPartIds.has(part.id)) return false;
        const finished = part.time === undefined || part.time.end !== undefined;
        if (!finished) return false;
        this.emittedPartIds.add(part.id);
        return true;
      }
      case 'tool': {
        if (part.state.status === 'pending') return false;
        if (part.state.status === 'running') {
          if (this.emittedToolRunning.has(part.callID)) return false;
          this.emittedToolRunning.add(part.callID);
          return true;
        }
        return true;
      }
      default:
        // Unhandled part kinds fall through to opencodeMessageToEntries'
        // default case, which drops them the same way sdkMessageToEntries
        // drops unrecognized SDK message types.
        return true;
    }
  }

  /**
   * Bridges one OpenCode permission ask into the SAME `canUseTool` callback
   * SessionRunner already builds for Claude Code (session/runner.ts's
   * `canUseTool` field, which forwards into `PermissionBroker.handleCanUseTool`)
   * — this facade never talks to PermissionBroker directly, only through the
   * SdkSessionOptions.canUseTool seam every facade is handed.
   *
   * Mapping (best-effort; OpenCode's Permission has no 1:1 analog to Claude's
   * canUseTool args):
   *   toolName  <- permission.type   (closest thing to a tool-category id)
   *   toolInput <- permission.metadata
   *   toolUseID <- permission.callID ?? permission.id
   * Reply is allow/deny only — 'once' or 'reject' — no 'always' persistence
   * and no doom-loop detection in this pass.
   */
  private handlePermission(client: OpencodeClient, permission: Permission): void {
    if (this.answeredPermissions.has(permission.id)) return;
    this.answeredPermissions.add(permission.id);

    const toolUseID = permission.callID ?? permission.id;
    this.canUseTool(permission.type, permission.metadata ?? {}, {
      signal: this.abortController.signal,
      toolUseID,
      requestId: permission.id,
      title: permission.title,
    })
      .then((result) => this.replyPermission(client, permission.id, result))
      .catch((err) => {
        // Fail closed: an unexpected canUseTool rejection must not leave
        // OpenCode's tool call waiting on a reply that never comes.
        void this.replyPermission(client, permission.id, {
          behavior: 'deny',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private async replyPermission(
    client: OpencodeClient,
    permissionId: string,
    result: SdkPermissionResult | null,
  ): Promise<void> {
    // null means "already answered out-of-band" per the CanUseTool contract
    // (see facade.ts's re-exported type doc) — nothing in this facade ever
    // does that, but honoring the contract means not guessing at a response.
    if (!result) return;
    const response = result.behavior === 'allow' ? 'once' : 'reject';
    try {
      const { session } = await this.ready;
      await client.postSessionIdPermissionsPermissionId({
        path: { id: session.id, permissionID: permissionId },
        query: { directory: this.cwd },
        body: { response },
      });
    } catch {
      // Best-effort — the permission then times out server-side; there is no
      // live connection left to retry over.
    }
  }

  messages(): AsyncIterable<SdkMessage> {
    return this.queue.drain();
  }

  pushInput(text: string): void {
    this.ready
      .then(({ client, session }) =>
        client.session.promptAsync({
          path: { id: session.id },
          query: { directory: this.cwd },
          body: {
            parts: [{ type: 'text', text }],
            ...(this.model ? { model: this.model } : {}),
          },
        }),
      )
      .then(({ error }) => {
        if (error) {
          this.queue.push({
            type: 'opencode-error',
            content: `OpenCode prompt failed: ${JSON.stringify(error)}`,
          } as unknown as SdkMessage);
        }
      })
      .catch((err) => {
        this.queue.push({
          type: 'opencode-error',
          content: `OpenCode prompt failed: ${err instanceof Error ? err.message : String(err)}`,
        } as unknown as SdkMessage);
      });
  }

  /** No OpenCode equivalent to Claude Code's session-scoped permission mode:
   *  OpenCode always asks per tool call via permission.updated events, and
   *  this facade always bridges every ask through canUseTool regardless of
   *  mode (see handlePermission) — there is nothing to switch. Intentional
   *  no-op; must not throw (SdkSessionHandle's contract). */
  async setPermissionMode(_mode: PermissionMode): Promise<void> {}

  /** No OpenCode equivalent to Claude Code's mid-session reasoning-effort
   *  control. Intentional no-op; must not throw (SdkSessionHandle's
   *  contract). */
  async setEffort(_level: EffortLevel): Promise<void> {}

  /** OpenCode has no session-level "current model" setter — model selection
   *  is a per-prompt field (SessionPromptData.body.model). Store the split
   *  id and apply it to every subsequent pushInput's prompt call. */
  async setModel(model: string): Promise<void> {
    this.model = splitModelId(model);
  }

  async interrupt(): Promise<void> {
    try {
      const { client, session } = await this.ready;
      await client.session.abort({ path: { id: session.id }, query: { directory: this.cwd } });
    } catch {
      // Best-effort, mirrors RealSdkSessionHandle's fire-and-forget
      // q.interrupt() — an already-idle OpenCode session can legitimately
      // 404 on abort.
    }
  }

  async probeReady(): Promise<void> {
    await this.ready;
  }

  /** OpenCode has no equivalent control request to feature-detect against —
   *  always null, never fabricated (see this module's doc comment). */
  async getContextUsage(): Promise<SdkContextUsage | null> {
    return null;
  }

  /** Same as getContextUsage(): no OpenCode equivalent, always null. */
  async getUsageSnapshot(): Promise<unknown | null> {
    return null;
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.abortController.abort();
    this.queue.close();
    try {
      const { client, session } = await this.ready;
      await client.session.abort({ path: { id: session.id }, query: { directory: this.cwd } });
    } catch {
      // Best-effort — `ready` may itself have rejected (session never
      // created), or the session may already be gone server-side.
    }
  }
}

export class OpenCodeFacade implements SdkFacade {
  private readonly baseUrl?: string;
  private clientPromise: Promise<OpencodeClient> | null = null;

  constructor(opts: OpenCodeFacadeOptions = {}) {
    this.baseUrl = opts.baseUrl;
  }

  private getClient(): Promise<OpencodeClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.baseUrl
        ? Promise.resolve(createOpencodeClient({ baseUrl: this.baseUrl }))
        : createOpencode().then(({ client }) => client);
    }
    return this.clientPromise;
  }

  createSession(opts: SdkSessionOptions): SdkSessionHandle {
    return new OpenCodeSessionHandle(opts, this.getClient());
  }

  /** Best-effort model list from OpenCode's configured providers — empty
   *  array on any failure (no live session required to ask, unlike Claude
   *  Code's supportedModels(), which needs a live query). Ids are composed as
   *  `<providerID>/<modelID>` — the same shape splitModelId expects back. */
  async supportedModels(): Promise<SdkModelDescriptor[]> {
    try {
      const client = await this.getClient();
      const { data, error } = await client.config.providers();
      if (error || !data) return [];
      const out: SdkModelDescriptor[] = [];
      for (const provider of data.providers) {
        for (const model of Object.values(provider.models)) {
          out.push({ id: `${provider.id}/${model.id}`, label: model.name });
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
