/**
 * SessionRunner — drives ONE Claude session through the SdkFacade seam.
 *
 * Ported from the old bridge's sdkSession.ts (SdkSessionManager), split per
 * session and re-plumbed onto the rebuilt persistence layer:
 * - Two-phase pending/ready creation (ported): the session surfaces as a
 *   `session-pending` placeholder immediately; it becomes real only when the
 *   SDK confirms with an init message (which carries the authoritative
 *   sdkSessionId for later --resume). Creation failure surfaces an error entry
 *   and a `session-failed` — never a ghost session.
 * - Seq/history REWRITTEN (the point of the rebuild): every output entry goes
 *   through TranscriptStore.append, which assigns the durable seq. No in-memory
 *   history cap, no seq reset on restart, no out-of-band `nextSeq` hack — the
 *   CDB-025 unique-seq guarantee now falls out of the store.
 * - Permission arbitration delegates to the shared PermissionBroker (CDX-005c).
 * - NO nostr imports: everything the phone must learn goes out through the
 *   SessionRunnerEvents seam; the orchestrator owns publishing.
 */
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  EffortLevel,
  OutputEntry,
  PermissionMode,
  SessionState,
  UsageData,
} from '@codedeck/protocol';
import type {
  SdkAuthStatusMessage,
  SdkCanUseTool,
  SdkContextUsage,
  SdkFacade,
  SdkMessage,
  SdkSessionHandle,
  SdkSessionOptions,
  SdkSystemMessage,
} from '../sdk/facade';
import { sdkMessageToEntries } from '../sdk/adapter';
import { normalizeUsage } from '../sdk/usage';

const execFileAsync = promisify(execFile);

/**
 * Read the current git HEAD commit hash for a working directory (ported).
 * Returns null if the dir is not a git repo or git is unavailable.
 */
export async function gitHeadHash(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      timeout: 5000,
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
import type { TranscriptStore } from './transcript';
import type { SessionRegistry, SessionRecord } from './registry';
import type { PermissionBroker } from './permissions';

/**
 * Is this input a slash command rather than prose? Claude Code treats the first token of such a
 * message as the command and EVERYTHING after it as `$ARGUMENTS`, so anything the bridge appends
 * to it changes what the command does (ported, CDB-034).
 */
export function isSlashCommand(text: string): boolean {
  return /^\/[A-Za-z][\w:-]*(\s|$)/.test(text);
}

export interface SeqEntry {
  seq: number;
  entry: OutputEntry;
}

export type RunnerPhase = 'pending' | 'ready' | 'failed' | 'ended';

export interface SessionRunnerEvents {
  /** New transcript entries were appended (seq already assigned) — publish as live output. */
  onOutput: (sessionId: string, entries: SeqEntry[]) => void;
  /** The SDK confirmed the session (two-phase flip) — publish session-ready + session list. */
  onReady?: (sessionId: string) => void;
  /** Creation failed before the SDK confirmed — publish session-failed. */
  onFailed?: (sessionId: string, reason: string) => void;
  /** Registry-visible session state changed — republish the session list. */
  onStateChanged?: (sessionId: string) => void;
  /** Tracked permission mode changed (keypress flow / SDK auto) — publish mode-confirmed. */
  onModeChanged?: (sessionId: string, mode: PermissionMode) => void;
  /** The session ended for good (stream closed, or died past the restart cap). */
  onEnded?: (sessionId: string) => void;
  log: (msg: string) => void;
}

export interface SessionRunnerOptions {
  sessionId: string;
  cwd: string;
  facade: SdkFacade;
  transcript: TranscriptStore;
  registry: SessionRegistry;
  broker: PermissionBroker;
  events: SessionRunnerEvents;
  /** Initial permission mode. Defaults to 'plan' (matches the old bridge). */
  permissionMode?: PermissionMode;
  model?: string;
  /**
   * CDX-062: id of the custom provider profile this session is bound to for
   * its whole lifetime (absent = Anthropic). Passed to `sessionEnv` at every
   * spawn and persisted in the registry record (resume rehydrates it).
   */
  providerId?: string;
  effortLevel?: EffortLevel;
  /** Attach on-device test tooling semantics (secret-path hard deny in the broker). */
  testSession?: boolean;
  /**
   * Resume a registry-persisted session instead of creating a fresh one
   * (resume-on-boot). The runner starts in phase 'ready' — the phone already
   * knows this session — and resumes via the record's sdkSessionId.
   */
  resume?: boolean;
  mcpServers?: SdkSessionOptions['mcpServers'];
  pathToClaudeCodeExecutable?: string;
  /**
   * Subprocess environment builder, evaluated at EVERY spawn (create AND
   * restart) so credentials set mid-life reach the next subprocess (CDX-011;
   * the old bridge snapshotted once at creation — the getter is strictly
   * better). CDX-062: receives the session's provider binding so the
   * orchestrator can resolve the LIVE profile per spawn (token rotation
   * reaches restarts); MAY THROW for a bound-but-deleted profile — the runner
   * fails the spawn loudly, never silently falls back to Anthropic. Returns
   * undefined to inherit process.env. Secrets: never logged.
   */
  sessionEnv?: (ctx: { providerId?: string }) => Record<string, string> | undefined;
  /** Injectable git-HEAD reader (commit detection) — defaults to the real one. */
  gitHead?: (cwd: string) => Promise<string | null>;
  /**
   * CDX-050: whether to emit `diff` entries for file edits, evaluated per SDK
   * message. The orchestrator answers from the phone-side capability registry
   * (every known phone must have advertised 'diff'); default off — pre-CDX-050
   * phones reject the unknown entryType.
   */
  emitDiffEntries?: () => boolean;
}

export class SessionRunner {
  private static readonly MAX_RESTARTS = 2;

  readonly sessionId: string;
  readonly cwd: string;
  readonly testSession: boolean;

  private readonly facade: SdkFacade;
  private readonly transcript: TranscriptStore;
  private readonly registry: SessionRegistry;
  private readonly broker: PermissionBroker;
  private readonly events: SessionRunnerEvents;
  private readonly isResume: boolean;
  private readonly mcpServers?: SdkSessionOptions['mcpServers'];
  private readonly claudePath?: string;
  private readonly sessionEnv?: (ctx: { providerId?: string }) => Record<string, string> | undefined;
  private readonly emitDiffEntries?: () => boolean;

  private handle: SdkSessionHandle | null = null;
  private _phase: RunnerPhase = 'pending';
  private _alive = true;
  private restartCount = 0;

  private permissionMode: PermissionMode;
  private model?: string;
  /** CDX-062: the profile id this session is bound to (absent = Anthropic). */
  private _providerId?: string;
  private effortLevel?: EffortLevel;
  /** The SDK's own session id — the --resume target. Updated from every init message. */
  private sdkSessionId: string | null = null;
  /**
   * CDX-073: the last sdkSessionId dropped as unresumable. `sdkSessionId` is the
   * ONLY pointer to the conversation on disk, so clearing it used to destroy the
   * evidence too — a false positive orphaned the conversation permanently and
   * silently. Keeping the dropped id (persisted, rehydrated on resume) makes a
   * wrong drop diagnosable and the conversation recoverable by hand.
   */
  private previousSdkSessionId?: string;
  /**
   * CDX-073: the resume target handed to the CURRENT spawn (null = spawned
   * fresh). Structural half of the unresumable discriminator: if we never asked
   * to resume anything, "no conversation found" in the error text cannot be
   * about our resume.
   */
  private resumeTargetInFlight: string | null = null;
  /**
   * CDX-073: SDK messages seen on the current spawn. >0 proves the subprocess
   * came up and (if a resume was requested) the conversation resolved — so a
   * later exit is some OTHER failure, no matter what its stderr tail contains.
   */
  private msgsOnCurrentSpawn = 0;
  private sessionState: 'idle' | 'running' = 'idle';
  private lastActivity: string;
  private readonly createdAt: string;

  private title: string | null = null;
  private projectOverride?: string;
  private summarized = false;
  private metaRequested = false;
  /**
   * CDX-082: texts this runner has already authored a `role: 'user'` transcript
   * entry for (see `sendInput`). Claude Code 2.1.220 does not echo pushed user
   * messages, but an SDK that DOES would produce a second, identical entry and
   * the phone would render the message twice. Each echo consumes one recorded
   * text, so two genuine identical sends still yield two entries. Bounded at 16
   * — a stale text only matters within the same turn.
   */
  private authoredUserTexts: string[] = [];
  /** Most recent Task/Agent subagent_type — best-effort label for sub-agent permission cards. */
  private lastSubagentType?: string;

  // --- Git-commit detection (ported) ---
  private readonly gitHead: (cwd: string) => Promise<string | null>;
  /** Whether a commit has been detected in this session — agent- or user-made. */
  private committed = false;
  /** git HEAD captured at session start; `committed` flips once HEAD advances past it. */
  private baseHead?: string;

  // --- Context usage (ported) ---
  private contextWindow?: number;
  private contextPercentage?: number;

  constructor(opts: SessionRunnerOptions) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.facade = opts.facade;
    this.transcript = opts.transcript;
    this.registry = opts.registry;
    this.broker = opts.broker;
    this.events = opts.events;
    this.permissionMode = opts.permissionMode ?? 'plan';
    this.model = opts.model;
    this._providerId = opts.providerId;
    this.effortLevel = opts.effortLevel;
    this.testSession = !!opts.testSession;
    this.isResume = !!opts.resume;
    this.mcpServers = opts.mcpServers;
    this.claudePath = opts.pathToClaudeCodeExecutable;
    this.sessionEnv = opts.sessionEnv;
    this.emitDiffEntries = opts.emitDiffEntries;
    this.gitHead = opts.gitHead ?? gitHeadHash;
    this.createdAt = new Date().toISOString();
    this.lastActivity = this.createdAt;

    if (this.isResume) {
      // The session already exists for the phone — no pending/ready dance.
      this._phase = 'ready';
      const rec = this.registry.get(this.sessionId);
      if (rec) {
        this.sdkSessionId = rec.sdkSessionId;
        // CDX-073: a previously dropped resume target survives the reboot so the
        // startup log can say WHICH conversation was lost instead of implying
        // this session never had one.
        if (rec.previousSdkSessionId) this.previousSdkSessionId = rec.previousSdkSessionId;
        this.permissionMode = rec.permissionMode ?? this.permissionMode;
        this.model = rec.model ?? this.model;
        // CDX-062: the provider binding survives resume-on-boot via the record.
        this._providerId = rec.providerId ?? this._providerId;
        this.effortLevel = rec.effortLevel ?? this.effortLevel;
        this.title = rec.title;
        this.projectOverride = rec.project;
        this.summarized = rec.title !== null; // don't re-ask for meta on resume
        this.metaRequested = rec.title !== null;
        this.committed = rec.committed === true;
        if (rec.contextWindow !== undefined) this.contextWindow = rec.contextWindow;
        if (rec.contextPercentage !== undefined) this.contextPercentage = rec.contextPercentage;
      }
    }
  }

  /**
   * CDX-060: fire-and-forget a background promise with a terminal catch.
   * Every `void someAsync()` whose chain can reject (transcript/registry I/O
   * after the state dir vanished — test teardown races, or a wiped dir in
   * prod) otherwise surfaces as an UNHANDLED REJECTION: in vitest it fails
   * whatever unrelated test is running; in production Node it would crash the
   * bridge. Failures here are log-worthy, never fatal.
   */
  private bg(label: string, p: Promise<unknown>): void {
    p.catch((err) => {
      this.events.log(`[Runner] ${label} failed for ${this.sessionId}: ${err}`);
    });
  }

  get phase(): RunnerPhase {
    return this._phase;
  }

  /** CDX-062: the custom provider profile this session is bound to, if any.
   *  The orchestrator gates usage publishing and model changes on it. */
  get providerId(): string | undefined {
    return this._providerId;
  }

  get alive(): boolean {
    return this._alive;
  }

  /** Registry-visible state, derived from broker pendings + the SDK idle/running signal. */
  state(): SessionState {
    if (!this._alive) return 'idle';
    if (this.broker.hasPendingPermissions(this.sessionId)) return 'waiting_permission';
    if (this.broker.hasPendingQuestions(this.sessionId)) return 'waiting_question';
    return this.sessionState;
  }

  /**
   * Spawn the SDK session and start consuming its stream. For a fresh session
   * the caller publishes `session-pending` BEFORE calling this; the runner
   * flips to ready (and creates the registry record) on the SDK init message.
   */
  start(): void {
    try {
      // sessionOptions() may throw from sessionEnv (CDX-062: a resumed session
      // whose provider profile was deleted) — same failure path as a spawn throw.
      const options = this.sessionOptions();
      this.beginSpawn(options.resume ?? null);
      this.handle = this.facade.createSession(options);
    } catch (err) {
      // CDX-074: both of these await transcript I/O — exactly the rejection
      // source bg() exists for. `void` left them uncaught, so a vanished state
      // dir here would take down the bridge instead of logging. A process-level
      // backstop now exists too — `installProcessGuards()` (src/process/guards.ts),
      // installed in both hosts (apps/bridge-cli/src/main.ts, and a narrower
      // variant in apps/bridge-vscode/src/extension.ts) — but it is a last
      // resort that logs and keeps running, NOT a substitute for catching here:
      // it cannot fail this session honestly or emit `session-failed`.
      if (this._phase === 'pending') {
        this.bg('creation failure', this.failCreation(`SDK session spawn failed: ${err}`));
      } else {
        // Resume-on-boot spawn failed (phase is already 'ready' — failCreation
        // would no-op). Fail LOUDLY with an error entry — never a ghost that
        // silently fell back to the wrong provider (CDX-062 D3).
        this.bg('resumed-spawn failure', this.failResumedSpawn(err));
      }
      return;
    }
    // Capture the starting git HEAD so commits made any way (agent Bash or a
    // manual terminal) are detected (ported). Not re-captured when the session
    // already detected a commit (resume keeps the badge).
    if (!this.committed) {
      this.bg('git HEAD capture', this.gitHead(this.cwd).then((head) => {
        if (head && !this.baseHead) this.baseHead = head;
      }));
    }
    if (this.isResume) {
      if (!this.sdkSessionId) this.announceFreshStart();
      // The record was 'offline' from the last shutdown — it is live again.
      void this.registry.update(this.sessionId, { state: 'idle' });
    } else {
      this.bg('creation probe', this.probeCreation(this.handle));
    }
    this.consumeInBackground(this.handle);
  }

  /**
   * Resume-on-boot with NO resume target. Two very different situations reach
   * here and CDX-073 turns on telling them apart:
   * - seqHigh 0 — the session genuinely never ran a turn (ready came from the
   *   control-channel probe; the SDK materializes a conversation on the first
   *   turn). Nothing existed to lose; this is CDX-056's case.
   * - seqHigh > 0 — the session HAS history, so its conversation existed and is
   *   gone (dropped as unresumable, or cleared by hand). Logging the turn-less
   *   line here is the exact misreading that log was added to prevent.
   *
   * LOG ONLY, deliberately. The user was already told, in this same transcript,
   * at the moment the conversation was dropped — handleStreamError emits it on
   * BOTH its branches now. A second telling at boot would be appended again on
   * every subsequent bridge restart of an untouched session (nothing clears the
   * condition until the next turn's init lands), so it grows without bound and,
   * because it takes a seq, it moves the retention window of a transcript that
   * nothing in the session actually wrote to. This log line is what CDX-073
   * needed; the transcript entry was reach it did not need.
   */
  private announceFreshStart(): void {
    const seqHigh = this.transcript.seqHigh(this.sessionId);
    if (seqHigh === 0) {
      this.events.log(
        `[Runner] Session ${this.sessionId} has no SDK conversation yet (never ran a turn) — starting fresh in ${this.cwd}`,
      );
      return;
    }
    const dropped = this.previousSdkSessionId ? ` (dropped ${this.previousSdkSessionId})` : '';
    this.events.log(
      `[Runner] Session ${this.sessionId} has ${seqHigh} transcript entries but no resumable SDK conversation${dropped} — starting a FRESH conversation in ${this.cwd}; the model does not remember earlier turns`,
    );
  }

  /** Record what the spawn about to happen asked for (CDX-073 discriminator state). */
  private beginSpawn(resumeTarget: string | null): void {
    this.resumeTargetInFlight = resumeTarget;
    this.msgsOnCurrentSpawn = 0;
  }

  /**
   * CDX-074: run the stream consumer in the background with a TERMINAL catch.
   * A bare `bg()` here logs and returns, which is the worst possible outcome:
   * `consume` rejecting means neither the respawn nor `endSession()` ran, so
   * `_alive` stays true and `_phase` stays 'ready' — the phone keeps showing a
   * live session, `sendInput` keeps returning true into a dead input channel,
   * and `onEnded` never fires so the session is never removed from the list.
   * Route the failure into the same terminal path the stream's own errors take.
   */
  private consumeInBackground(handle: SdkSessionHandle): void {
    this.consume(handle).catch((err) => {
      this.events.log(`[Runner] stream consumer failed for ${this.sessionId}: ${err}`);
      if (!this._alive || this.handle !== handle) return; // already terminal, or superseded
      if (this._phase === 'pending') {
        this.bg('consumer failure (pending)', this.failCreation(`SDK stream consumer failed: ${err}`));
        return;
      }
      // endSession() flips _alive/_phase synchronously before its first await,
      // so sendInput() stops accepting messages even if the cleanup I/O fails.
      this.bg('consumer failure (ready)', this.endSession());
    });
  }

  /**
   * Two-phase flip for a FRESH idle session. SDK 0.3.222 emits `init` only
   * after the first streamed user message, so ready cannot be gated on init
   * alone — an idle created session would stay 'pending' forever (the phone's
   * placeholder never resolves; found on the real-socket rig, Phase 3d).
   * A control-channel round-trip proves the subprocess spawned and responds:
   * flip ready on it. `init` still owns the authoritative sdkSessionId and
   * permissionMode when it later arrives (the non-pending branch of
   * handleMessage persists them). Probe rejection while still pending is a
   * spawn/startup failure. A probe that never settles leaves the pre-fix
   * behavior (pending until the stream errors/closes) — no ghost sessions.
   */
  private async probeCreation(handle: SdkSessionHandle): Promise<void> {
    try {
      await handle.probeReady();
    } catch (err) {
      if (this._alive && this.handle === handle && this._phase === 'pending') {
        await this.failCreation(`SDK session did not respond: ${err}`);
      }
      return;
    }
    if (!this._alive || this.handle !== handle || this._phase !== 'pending') return;
    this._phase = 'ready';
    await this.registry.upsert(this.record());
    this.events.log(
      `[Runner] Session ${this.sessionId} ready (control-channel probe; sdk id follows on first turn)`,
    );
    this.events.onReady?.(this.sessionId);
  }

  private sessionOptions(): SdkSessionOptions {
    // CDX-056: resume ONLY a conversation the SDK actually created. A session
    // that never ran a turn has `sdkSessionId: null` (the SDK materializes a
    // conversation on the first turn, after the control-channel probe already
    // flipped us ready) — the old `?? this.sessionId` fallback asked the SDK to
    // resume a conversation that never existed, which fails every time with
    // "No conversation found", burned both restarts, and silently ended the
    // session. No sdk id ⇒ spawn FRESH in the same cwd; nothing existed to lose.
    const resumeTarget = this.isResume ? this.sdkSessionId : undefined;
    // Fresh env per spawn: credentials stored since the last spawn apply to
    // this one (restarts included — sessionOptions() is called again there).
    // CDX-062: the provider binding rides along so the orchestrator resolves
    // the LIVE profile per spawn; this call MAY THROW (deleted profile) and
    // every caller routes that into a loud failure path.
    const env = this.sessionEnv?.(this._providerId ? { providerId: this._providerId } : {});
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      canUseTool: this.canUseTool,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effortLevel ? { effortLevel: this.effortLevel } : {}),
      // CDX-071: the AUTHORITATIVE provider-bound signal for the facade's
      // isProviderBoundSession — which decides whether this session may answer
      // the machine-wide Anthropic model list, and whether the operator's
      // cloud-backend flags and custom headers are stripped from its env. It
      // fell back to reading `fallbackModel === null` as a proxy only because
      // this file was not the provider agent's to edit. Purely declarative:
      // buildQueryOptions never forwards it to the SDK.
      ...(this._providerId ? { providerId: this._providerId } : {}),
      // CDX-062: the Anthropic fallback constant is not a valid model at a
      // custom provider — omit fallbackModel entirely for bound sessions.
      // Kept exactly as-is: the two signals agree, and the proxy stays valid.
      ...(this._providerId ? { fallbackModel: null } : {}),
      ...(resumeTarget ? { resume: resumeTarget } : {}),
      ...(this.mcpServers ? { mcpServers: this.mcpServers } : {}),
      ...(this.claudePath ? { pathToClaudeCodeExecutable: this.claudePath } : {}),
      ...(env ? { env } : {}),
    };
  }

  /** The SDK canUseTool callback — all arbitration delegates to the shared broker. */
  private readonly canUseTool: SdkCanUseTool = (toolName, toolInput, options) =>
    this.broker.handleCanUseTool(
      {
        sessionId: this.sessionId,
        permissionMode: this.permissionMode,
        testSession: this.testSession,
        ...(this.lastSubagentType ? { agentLabel: this.lastSubagentType } : {}),
      },
      toolName,
      toolInput as Record<string, unknown>,
      {
        toolUseID: options.toolUseID,
        ...(options.agentID ? { agentID: options.agentID } : {}),
        ...(options.title ? { title: options.title } : {}),
        ...(options.description ? { description: options.description } : {}),
      },
    );

  // --- Message stream ---

  private async consume(handle: SdkSessionHandle): Promise<void> {
    try {
      for await (const msg of handle.messages()) {
        if (!this._alive || this.handle !== handle) break;
        // CDX-073: the spawn produced output — whatever kills it later is not a
        // failure to find the conversation we asked to resume.
        this.msgsOnCurrentSpawn++;
        await this.handleMessage(msg);
        if (this._phase === 'failed') break;
      }
    } catch (err) {
      if (!this._alive || this.handle !== handle) return;
      if (this._phase === 'pending') {
        await this.failCreation(`SDK stream error before the session was confirmed: ${err}`);
        return;
      }
      await this.handleStreamError(err);
      return;
    }
    if (!this._alive || this.handle !== handle || this._phase === 'failed') return;

    // Stream ended cleanly (subprocess exit).
    if (this._phase === 'pending') {
      await this.failCreation('SDK stream closed before the session was confirmed');
      return;
    }
    await this.endSession();
  }

  private async handleMessage(msg: SdkMessage): Promise<void> {
    // Auth error detection: the SDK emits auth_status with an error on failure.
    if (msg.type === 'auth_status') {
      const auth = msg as SdkAuthStatusMessage;
      if (auth.error) {
        this.events.log(`[Runner] Auth error for ${this.sessionId}: ${auth.error}`);
        if (this._phase === 'pending') {
          await this.failCreation(`Authentication failed: ${auth.error}`);
          this.bg('dead handle end', Promise.resolve(this.handle?.end()));
          return;
        }
        await this.appendAndEmit([{
          entryType: 'error',
          content: `Authentication failed: ${auth.error}`,
          timestamp: new Date().toISOString(),
          metadata: { special: 'auth_error' },
        }]);
      }
      return; // never forward auth_status to the phone
    }

    // Init: the SDK's confirmation — carries the authoritative sdkSessionId and
    // the mode the session actually started in. This is the two-phase flip.
    if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
      const init = msg as SdkSystemMessage;
      this.sdkSessionId = init.session_id;
      // The protocol has no bypassPermissions — coerce anything unknown to 'default'.
      this.permissionMode =
        init.permissionMode === 'plan' || init.permissionMode === 'acceptEdits'
          ? init.permissionMode
          : 'default';
      // CDX-087: record the model the SDK actually RESOLVED. `this.model` only
      // held what the phone requested, so a session started on "Default model"
      // reported none at all and the phone's header badge had nothing to show.
      // init.model is required on the message and arrives on every turn's init,
      // so this also self-corrects after a setModel and on resume.
      // Bonus: `modelUsage` (result messages, below) is keyed by the RESOLVED
      // id, so the context-window lookup starts hitting instead of falling back
      // to the largest reported window — a requested alias like `opus[1m]` never
      // matched a key.
      const modelChanged = typeof init.model === 'string' && init.model !== ''
        && init.model !== this.model;
      if (modelChanged) this.model = init.model;
      if (this._phase === 'pending') {
        this._phase = 'ready';
        await this.registry.upsert(this.record());
        this.events.log(`[Runner] Session ${this.sessionId} ready (sdk: ${this.sdkSessionId})`);
        this.events.onReady?.(this.sessionId);
      } else {
        // Only the fields that actually moved: every registry update publishes a
        // heartbeat, and publish budget is not free.
        await this.registry.update(this.sessionId, {
          sdkSessionId: this.sdkSessionId,
          permissionMode: this.permissionMode,
          ...(modelChanged && this.model ? { model: this.model } : {}),
        });
        this.events.onStateChanged?.(this.sessionId);
      }
      // fall through — the adapter also emits a visible init system entry
    }

    // idle/running transitions (turn boundaries).
    if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'session_state_changed') {
      const state = (msg as unknown as { state: string }).state;
      this.sessionState = state === 'idle' ? 'idle' : 'running';
      await this.refreshRegistryState();
      this.events.onStateChanged?.(this.sessionId);
    }

    // Capture the SDK-resolved context window from result messages so the phone
    // can use the real denominator (e.g. the 1M-beta window) for its
    // context-usage %, instead of guessing from the model-id string (ported).
    // `modelUsage` is keyed by model id; prefer the main session model, else
    // the largest window reported (sub-agents may run other models).
    if (msg.type === 'result') {
      const modelUsage = (msg as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage;
      if (modelUsage) {
        const cw = (this.model && modelUsage[this.model]?.contextWindow)
          || Math.max(0, ...Object.values(modelUsage).map((u) => u?.contextWindow ?? 0));
        if (cw > 0 && cw !== this.contextWindow) {
          this.contextWindow = cw;
          if (this._phase === 'ready') {
            await this.registry.update(this.sessionId, { contextWindow: cw });
          }
          this.events.onStateChanged?.(this.sessionId);
        }
      }
      // Refresh the SDK's authoritative context-usage % — context only changes
      // at turn boundaries, so per-result is the right cadence. Fire-and-forget
      // so it never blocks stream processing; republish on change (ported).
      this.bg('context refresh', this.refreshContextPercentage());
    }

    const entries = sdkMessageToEntries(msg, {
      emitDiffEntries: this.emitDiffEntries?.() === true,
    }).filter((entry) => {
      // CDX-082: drop an SDK echo of a message we already authored an entry for.
      if (entry.entryType !== 'text' || entry.metadata?.role !== 'user') return true;
      const i = this.authoredUserTexts.indexOf(entry.content);
      if (i === -1) return true;
      this.authoredUserTexts.splice(i, 1);
      return false;
    });
    if (entries.length === 0) return;

    // Track the most recent sub-agent type so a sub-agent's permission card can
    // be labelled on the phone (best-effort, ported).
    for (const entry of entries) {
      if (entry.entryType === 'tool_use'
          && (entry.metadata?.tool_name === 'Task' || entry.metadata?.tool_name === 'Agent')) {
        const sub = (entry.metadata?.tool_input as Record<string, unknown> | undefined)?.subagent_type;
        if (typeof sub === 'string' && sub) this.lastSubagentType = sub;
      }
    }

    // Fast path: the agent may have just run `git commit`. Verify against git
    // HEAD right away so the badge updates without waiting for the next poll —
    // manual commits are caught by the orchestrator's poll (ported).
    if (!this.committed) {
      for (const entry of entries) {
        if (entry.entryType === 'tool_use'
            && entry.metadata?.tool_name === 'Bash'
            && /\bgit\s+commit\b(?!\s+--help)/.test(
                 String((entry.metadata?.tool_input as Record<string, unknown>)?.command ?? ''))) {
          this.bg('commit detection', this.detectCommit().then((changed) => {
            if (changed) this.events.log(`[Runner] Git commit detected in session ${this.sessionId}`);
          }));
          break;
        }
      }
    }

    // Parse the session-meta tag from the first assistant response (ported).
    //
    // CDX-082: the STRIP is unconditional, the PARSE is once-only. The tag is
    // requested exactly once (`metaRequested`), but the model sees the pattern
    // in its own context and re-emits it on later turns unprompted — device-
    // verified 2026-08-09, turn 2 rendered a literal
    // `<!-- session-meta: {...} -->` line in the transcript. Stripping only
    // while `!this.summarized` (the old shape) leaks every repeat. A malformed
    // tag is stripped too: it is bridge plumbing either way, never user content.
    for (const entry of entries) {
      if (entry.entryType !== 'text' || entry.metadata?.role !== 'assistant') continue;
      const match = entry.content.match(/<!--\s*session-meta:\s*(\{[^}]+\})\s*-->/);
      if (!match) continue;
      entry.content = entry.content.replace(/<!--\s*session-meta:\s*\{[^}]+\}\s*-->/g, '').trim();
      if (this.summarized) continue;
      try {
        const meta = JSON.parse(match[1]!) as { topic?: unknown; project?: unknown };
        if (meta.topic) this.title = String(meta.topic).slice(0, 40);
        if (meta.project) this.projectOverride = String(meta.project).slice(0, 40);
        this.summarized = true;
        this.events.log(`[Runner] Session meta: topic="${this.title}", project="${this.projectOverride}"`);
        if (this._phase === 'ready') {
          await this.registry.update(this.sessionId, {
            title: this.title,
            project: this.project(),
          });
        }
        this.events.onStateChanged?.(this.sessionId);
      } catch { /* ignore parse errors */ }
    }

    await this.appendAndEmit(entries);
  }

  /**
   * CDX-056/CDX-073: is this stream error the SDK refusing the resume target we
   * just handed it?
   *
   * The error string ALONE cannot answer that. The SDK builds a stream error as
   * `Claude Code process exited with code <n>. stderr: <last ~2048 chars>`, and
   * CodeDeck actively feeds that channel: `settingSources: ['user','project']`
   * runs the user's and the project's hooks, `mcpServers` are forwarded, and
   * everything the agent prints from Bash lands there. A hook line, or the agent
   * running `claude --resume <some-old-id>` in a shell, puts "no conversation
   * found" into the tail of an error whose actual cause is an OOM kill, a
   * SIGTERM or a network blip. Matching on the phrase then clears a LIVE
   * `sdkSessionId` — the only pointer to the conversation on disk — and the
   * model loses every earlier turn, permanently.
   *
   * So the phrase is the last check, not the first. It only counts when the
   * structure agrees:
   * - we actually asked this spawn to resume something (`resumeTargetInFlight`),
   *   otherwise there is no resume for the SDK to have failed;
   * - that target is still the id we hold (an init would have replaced it);
   * - the spawn produced ZERO messages, i.e. the conversation never came up. A
   *   resume that got as far as one message demonstrably succeeded, so a later
   *   exit is a different failure however its stderr reads;
   * - and the error names that exact id — the SDK's message is
   *   `No conversation found with session ID: <id>`, so stray stderr about some
   *   OTHER conversation no longer matches.
   *
   * The failure modes are deliberately asymmetric: a false negative ends one
   * session with its record intact (recoverable, and the next boot retries),
   * while a false positive destroys a conversation for good.
   */
  private isUnresumableResumeFailure(err: unknown): boolean {
    const target = this.resumeTargetInFlight;
    if (!target || target !== this.sdkSessionId) return false;
    if (this.msgsOnCurrentSpawn > 0) return false;
    const text = String(err);
    return /no conversation found/i.test(text) && text.includes(target);
  }

  /**
   * Drop an unresumable resume target so the next spawn starts fresh, and
   * persist the drop so a bridge restart doesn't re-attempt it either. CDX-073:
   * the dropped id is KEPT (in memory and in the record) — it is the only
   * pointer to the conversation on disk, and a wrong drop must stay diagnosable
   * and hand-recoverable instead of vanishing.
   */
  private dropResumeTarget(): void {
    const dropped = this.sdkSessionId;
    if (!dropped) return;
    this.events.log(
      `[Runner] SDK conversation ${dropped} for ${this.sessionId} is gone — dropping the resume target (kept as previousSdkSessionId), restart will start fresh in ${this.cwd}`,
    );
    this.previousSdkSessionId = dropped;
    this.sdkSessionId = null;
    this.resumeTargetInFlight = null;
    void this.registry.update(this.sessionId, {
      sdkSessionId: null,
      previousSdkSessionId: dropped,
    });
  }

  private async handleStreamError(err: unknown): Promise<void> {
    this.events.log(`[Runner] Session ${this.sessionId} message stream error: ${err}`);

    // CDX-073: NOT dropped here. The clear used to run before the restart gate,
    // so a session that had already burned both restarts had its only pointer to
    // the conversation destroyed and persisted while the whole restart block —
    // including the entry that tells the user the model forgot everything — was
    // skipped. The clear now travels WITH the honesty, in both branches below.
    const unresumable = this.isUnresumableResumeFailure(err);

    if (this.restartCount < SessionRunner.MAX_RESTARTS) {
      this.restartCount++;
      this.events.log(`[Runner] Restarting session ${this.sessionId} (attempt ${this.restartCount}/${SessionRunner.MAX_RESTARTS})`);

      // The old query is dead — END its handle so the facade prunes it
      // (CDX-022: an abandoned not-ended handle sits first in the facade's
      // insertion-ordered set forever and poisons supportedModels()).
      this.bg('dead handle end', Promise.resolve(this.handle?.end()));

      // Any permission/question promise still tied to the old query would
      // resolve into the void and strand the turn — drain them now so the
      // phone clears its waiting state and the user can retry (ported).
      this.broker.denyAllPending(this.sessionId, 'Session restarted — please retry');
      this.lastSubagentType = undefined; // fresh resumed query starts a fresh agent context
      // CDX-073: drop BEFORE the respawn (sessionOptions() reads sdkSessionId)
      // and in the same block as the entry that admits the memory loss.
      if (unresumable) this.dropResumeTarget();
      await this.refreshRegistryState();
      this.events.onStateChanged?.(this.sessionId);

      // CDX-074: best-effort. Pre-fix a rejecting append here skipped the
      // respawn AND endSession(), leaving a zombie: alive, 'ready', accepting
      // input into a closed channel, never removed from the phone's list.
      await this.tryAppend([{
        entryType: 'system',
        // CDX-056: when the conversation is gone, say what actually happens —
        // a fresh SDK conversation in the same workspace — instead of implying
        // a seamless resume the model's memory won't back up.
        content: unresumable
          ? `Session's SDK conversation was missing — starting a fresh conversation in the same workspace (attempt ${this.restartCount}). The transcript is preserved, but the model does not remember earlier turns.`
          : `Session interrupted — restarting (attempt ${this.restartCount})...`,
        timestamp: new Date().toISOString(),
        metadata: { special: 'session_restart' },
      }]);

      try {
        // sessionOptions() may throw from sessionEnv (CDX-062: the session's
        // provider profile was deleted mid-life) — routed into the same
        // error-entry + end path as restart exhaustion, never a bridge crash
        // and never a silent Anthropic fallback.
        // CDX-056: resume only a conversation the SDK confirmed (init's
        // session_id). With no sdk id — turn-less session, or a resume target
        // just dropped as unresumable — spawn fresh in the same cwd; the old
        // `?? this.sessionId` fallback resumed a conversation that never
        // existed and failed every attempt.
        const options = {
          ...this.sessionOptions(),
          ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
        };
        this.beginSpawn(options.resume ?? null);
        const newHandle = this.facade.createSession(options);
        this.handle = newHandle;
        this.consumeInBackground(newHandle);
        return;
      } catch (spawnErr) {
        this.events.log(`[Runner] Restart spawn failed for ${this.sessionId}: ${spawnErr}`);
        await this.tryAppend([{
          entryType: 'error',
          content: `Session restart failed: ${spawnErr instanceof Error ? spawnErr.message : spawnErr}`,
          timestamp: new Date().toISOString(),
          metadata: { special: 'session_died' },
        }]);
        await this.endSession();
        return;
      }
    }

    // Restarts exhausted. CDX-073: the drop belongs HERE too — not before the
    // gate — so the id is only destroyed together with an entry that admits it,
    // and so the next boot doesn't re-attempt the same doomed resume.
    this.events.log(`[Runner] Session ${this.sessionId} failed after ${this.restartCount} restarts`);
    if (unresumable) this.dropResumeTarget();
    await this.tryAppend([{
      entryType: 'error',
      content: unresumable
        ? 'Session ended: its SDK conversation was missing and the restart attempts are used up. The transcript is preserved; reopening this session starts a fresh conversation in the same workspace, and the model will not remember earlier turns.'
        : 'Session ended unexpectedly after multiple restart attempts.',
      timestamp: new Date().toISOString(),
      metadata: { special: 'session_died' },
    }]);
    await this.endSession();
  }

  /**
   * CDX-062: a RESUMED session's spawn threw (typically sessionEnv refusing a
   * deleted provider profile). The session already exists for the phone, so
   * failCreation's pending-only guard would swallow it — surface the reason as
   * an error transcript entry and end the session instead. Never crashes the
   * bridge, never falls back to another provider.
   */
  private async failResumedSpawn(err: unknown): Promise<void> {
    this.events.log(`[Runner] Session ${this.sessionId} resume spawn failed: ${err}`);
    await this.tryAppend([{
      entryType: 'error',
      content: `Session could not be resumed: ${err instanceof Error ? err.message : err}`,
      timestamp: new Date().toISOString(),
      metadata: { special: 'session_died' },
    }]);
    await this.endSession();
  }

  /** Terminal cleanup for a session that ended on its own (not close()). */
  private async endSession(): Promise<void> {
    // Flipped BEFORE the first await, so sendInput() stops accepting messages
    // the moment anything decides this session is over (CDX-074).
    this._alive = false;
    this._phase = 'ended';
    this.broker.denyAllPending(this.sessionId, 'Session ended');
    try {
      await this.registry.update(this.sessionId, { state: 'idle' });
    } catch (err) {
      // CDX-074: a failed state write must never swallow the announcement
      // below — onEnded is what removes the session from the phone's list, and
      // skipping it is precisely how a dead session stays on screen forever.
      this.events.log(`[Runner] end-state registry update failed for ${this.sessionId}: ${err}`);
    }
    this.bg('dead handle end', Promise.resolve(this.handle?.end()));
    this.events.log(`[Runner] Session ${this.sessionId} ended`);
    this.events.onEnded?.(this.sessionId);
  }

  private async failCreation(reason: string): Promise<void> {
    if (this._phase !== 'pending') return;
    this._phase = 'failed';
    this._alive = false;
    this.events.log(`[Runner] Session ${this.sessionId} creation failed: ${reason}`);
    // End the dead handle so the facade prunes it (CDX-022 — see handleStreamError).
    this.bg('dead handle end', Promise.resolve(this.handle?.end()));
    this.broker.denyAllPending(this.sessionId, 'Session creation failed');
    // Surface the failure in the output stream too — the transcript keeps the
    // evidence, and a phone already watching the pending card sees why.
    // CDX-074: best-effort — onFailed resolves the phone's pending placeholder,
    // so a transcript I/O failure must not be able to strand it.
    await this.tryAppend([{
      entryType: 'error',
      content: `Session creation failed: ${reason}`,
      timestamp: new Date().toISOString(),
      metadata: { special: 'session_failed' },
    }]);
    this.events.onFailed?.(this.sessionId, reason);
  }

  // --- Transcript plumbing (the seq rewrite) ---

  /**
   * Append entries to the durable transcript (seq assigned by the store, never
   * renumbered) and emit them for live publishing.
   */
  private async appendAndEmit(entries: OutputEntry[]): Promise<void> {
    const seqEntries: SeqEntry[] = [];
    for (const entry of entries) {
      const { seq } = await this.transcript.append(this.sessionId, entry);
      seqEntries.push({ seq, entry });
    }
    this.lastActivity = new Date().toISOString();
    if (this._phase === 'ready') {
      void this.registry.update(this.sessionId, { lastActivity: this.lastActivity });
    }
    this.events.onOutput(this.sessionId, seqEntries);
  }

  /**
   * CDX-074: append a notice whose FAILURE must not abort the caller. Every use
   * is on a terminal/restart path where the append is the announcement, not the
   * work: losing the notice costs the user an explanation, while letting it
   * reject costs them the respawn, the `onEnded`/`onFailed` event, and leaves a
   * session that reports itself alive forever.
   */
  private async tryAppend(entries: OutputEntry[]): Promise<void> {
    try {
      await this.appendAndEmit(entries);
    } catch (err) {
      this.events.log(`[Runner] notice append failed for ${this.sessionId}: ${err}`);
    }
  }

  /**
   * Append one out-of-band entry (permission card, auth notice, screenshot) —
   * the replacement for the old `nextSeq()` hack (CDB-025): the store assigns a
   * unique, correctly-ordered seq, so the phone's per-seq dedup can never drop it.
   */
  async appendEntry(entry: OutputEntry): Promise<SeqEntry> {
    const { seq } = await this.transcript.append(this.sessionId, entry);
    const seqEntry = { seq, entry };
    this.events.onOutput(this.sessionId, [seqEntry]);
    return seqEntry;
  }

  // --- Steering ---

  /**
   * Send user text input. While a turn is blocked on a pending AskUserQuestion,
   * ANY input can only be the answer to it — route it through the broker
   * instead of wedging it behind the blocked turn (ported stuck-session guard).
   */
  sendInput(text: string): boolean {
    if (!this._alive || !this.handle) return false;

    if (this.broker.hasPendingQuestions(this.sessionId)) {
      return this.broker.answerQuestion(this.sessionId, { text });
    }

    /** CDX-082: the text the USER actually typed, before the meta request is
     *  appended below — what the transcript entry and the phone's outbox row
     *  must both carry for `outboxCoverage` to match them. */
    const typed = text;

    this.lastActivity = new Date().toISOString();

    // Extract a title from the first usable user message (ported).
    const cleaned = text.replace(/\n/g, ' ').trim();
    const usable = !!cleaned && !cleaned.startsWith('[') && !cleaned.startsWith('Request interrupted');
    if (!this.title && usable) {
      this.title = cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
      if (this._phase === 'ready') {
        void this.registry.update(this.sessionId, { title: this.title, lastActivity: this.lastActivity });
      }
    }
    // CDB-034: everything after a slash command's name is its ARGUMENTS, so the
    // metadata request must never be appended to one — ask on the next ordinary
    // message instead (`metaRequested`, not `title`, tracks whether we owe it).
    if (!this.metaRequested && usable && !isSlashCommand(text)) {
      this.metaRequested = true;
      text += '\n\n<!-- emit-session-meta: In your response, include exactly one HTML comment: <!-- session-meta: {"topic": "<2-4 word task summary>", "project": "<project name>"} --> -->';
    }

    /**
     * CDX-082: the bridge authors the user's transcript entry itself.
     *
     * The old contract assumed the SDK echoes pushed user messages back as
     * `type: 'user'` stream messages, which the adapter maps to a
     * `role: 'user'` text entry — that echo is what `outboxCoverage` waits for
     * before it hides the phone's optimistic row. Claude Code 2.1.220 does NOT
     * echo them (device-verified 2026-08-09: two turns, transcript held only
     * system/assistant entries). The row therefore never got covered, so every
     * message the user sent stayed a permanent "delivered" outbox row and — as
     * outbox rows sort after all transcript entries — rendered BELOW the reply
     * it preceded. Two turns in, the conversation read inside-out.
     *
     * Appended BEFORE `pushInput` so the store's per-session write chain gives
     * it a lower seq than anything the reply produces. `tryAppend` because a
     * failed append must not cost the user the actual send.
     */
    this.authoredUserTexts.push(typed);
    if (this.authoredUserTexts.length > 16) this.authoredUserTexts.shift();
    void this.tryAppend([{
      entryType: 'text',
      content: typed,
      timestamp: this.lastActivity,
      metadata: { role: 'user' },
    }]);

    this.handle.pushInput(text);
    return true;
  }

  /** Answer the active AskUserQuestion; falls back to plain input when none is pending. */
  sendQuestionInput(text: string): boolean {
    if (!this._alive || !this.handle) return false;
    if (this.broker.answerQuestion(this.sessionId, { text })) {
      this.lastActivity = new Date().toISOString();
      return true;
    }
    this.events.log(`[Runner] No pending question for question-input in ${this.sessionId} — falling back to sendInput`);
    return this.sendInput(text);
  }

  /**
   * Handle a raw keypress for TUI-style prompts (ported from the old
   * BridgeCore.onKeypress). Contexts per the v10 protocol:
   * - 'plan-approval': 1 = approve + acceptEdits, 2 = approve + manual (default
   *   mode), 3 = revise (deny ExitPlanMode, stay in plan mode).
   * - 'question': 1-based option selection for the active AskUserQuestion.
   */
  async handleKeypress(key: string, context?: 'plan-approval' | 'question'): Promise<void> {
    if (!this._alive) return;

    if (context === 'plan-approval') {
      const toolUseId = this.broker.findPendingPermission(this.sessionId, 'ExitPlanMode');
      switch (key) {
        case '1': {
          if (toolUseId) this.broker.resolvePermission(toolUseId, true);
          await this.setPermissionMode('acceptEdits');
          this.events.onModeChanged?.(this.sessionId, 'acceptEdits');
          break;
        }
        case '2': {
          if (toolUseId) this.broker.resolvePermission(toolUseId, true);
          await this.setPermissionMode('default');
          this.events.onModeChanged?.(this.sessionId, 'default');
          break;
        }
        case '3': {
          // Revise plan — deny ExitPlanMode so Claude stays in plan mode.
          // The user's revision text arrives as the next input message.
          if (toolUseId) this.broker.resolvePermission(toolUseId, false);
          break;
        }
      }
      return;
    }

    if (context === 'question') {
      if (!this.broker.answerQuestion(this.sessionId, { keypress: key })) {
        this.events.log(`[Runner] No pending question for keypress '${key}' in ${this.sessionId}`);
      }
      return;
    }
  }

  /** Resolve a pending permission request from the phone (routes through the broker). */
  resolvePermission(requestId: string, allow: boolean, modifier?: 'always' | 'never'): boolean {
    return this.broker.resolvePermission(requestId, allow, modifier);
  }

  async setPermissionMode(mode: PermissionMode): Promise<boolean> {
    if (!this._alive || !this.handle) return false;
    try {
      await this.handle.setPermissionMode(mode);
      this.permissionMode = mode;
      if (this._phase === 'ready') {
        void this.registry.update(this.sessionId, { permissionMode: mode });
      }
      this.events.log(`[Runner] Permission mode set to ${mode} for ${this.sessionId}`);
      return true;
    } catch (err) {
      this.events.log(`[Runner] Failed to set permission mode for ${this.sessionId}: ${err}`);
      return false;
    }
  }

  /**
   * The SDK autonomously changed mode (EnterPlanMode) — update the tracked mode
   * WITHOUT calling back into the SDK.
   */
  applyAutoModeChange(mode: PermissionMode): void {
    this.permissionMode = mode;
    if (this._phase === 'ready') {
      void this.registry.update(this.sessionId, { permissionMode: mode });
    }
    this.events.onStateChanged?.(this.sessionId);
  }

  /**
   * Mid-session effort change. The facade accepts the full level set including
   * session-scoped 'max' (the old max→xhigh downgrade is obsolete, CDB-029).
   */
  async setEffort(level: EffortLevel): Promise<{ applied: boolean; confirmedLevel: EffortLevel }> {
    if (!this._alive || !this.handle) return { applied: false, confirmedLevel: level };
    try {
      await this.handle.setEffort(level);
      this.effortLevel = level;
      if (this._phase === 'ready') {
        void this.registry.update(this.sessionId, { effortLevel: level });
      }
      this.events.log(`[Runner] Effort level set to ${level} for ${this.sessionId}`);
      return { applied: true, confirmedLevel: level };
    } catch (err) {
      this.events.log(`[Runner] Failed to set effort level for ${this.sessionId}: ${err}`);
      return { applied: false, confirmedLevel: this.effortLevel ?? level };
    }
  }

  async setModel(model: string): Promise<{ applied: boolean; confirmedModel: string }> {
    if (!this._alive || !this.handle) return { applied: false, confirmedModel: model };
    try {
      await this.handle.setModel(model);
      this.model = model;
      if (this._phase === 'ready') {
        void this.registry.update(this.sessionId, { model });
      }
      this.events.log(`[Runner] Model set to ${model} for ${this.sessionId}`);
      return { applied: true, confirmedModel: model };
    } catch (err) {
      this.events.log(`[Runner] Failed to set model for ${this.sessionId}: ${err}`);
      // Confirm the previously-known model so the phone UI doesn't show a model that didn't take.
      return { applied: false, confirmedModel: this.model ?? model };
    }
  }

  /** Interrupt the current turn and drain pending permissions/questions (ported). */
  interrupt(): boolean {
    if (!this._alive || !this.handle) return false;
    this.events.log(`[Runner] Interrupting session ${this.sessionId}`);
    this.handle.interrupt().catch((err) => {
      this.events.log(`[Runner] Interrupt failed for ${this.sessionId}: ${err}`);
    });
    this.broker.denyAllPending(this.sessionId, 'Interrupted by user');
    this.bg('registry state refresh', this.refreshRegistryState());
    this.events.onStateChanged?.(this.sessionId);
    return true;
  }

  // --- Usage / context usage (ported from the old SdkSessionManager) ---

  /**
   * Structured subscription usage / rate-limit snapshot — the same data the
   * `/usage` command renders. The underlying SDK method is EXPERIMENTAL, so the
   * facade feature-detects and this normalizes defensively: dead sessions,
   * unsupported SDKs, or unexpected shapes all yield null and the caller
   * publishes nothing (the phone keeps its last value).
   */
  async getUsage(): Promise<UsageData | null> {
    if (!this._alive || !this.handle) return null;
    try {
      const raw = await this.handle.getUsageSnapshot();
      if (raw === null || raw === undefined) return null;
      return normalizeUsage(raw);
    } catch (err) {
      this.events.log(`[Runner] getUsage failed for ${this.sessionId}: ${err}`);
      return null;
    }
  }

  /** Authoritative context usage from the SDK (feature-detected in the facade). */
  async getContextUsage(): Promise<SdkContextUsage | null> {
    if (!this._alive || !this.handle) return null;
    try {
      return await this.handle.getContextUsage();
    } catch (err) {
      this.events.log(`[Runner] getContextUsage failed for ${this.sessionId}: ${err}`);
      return null;
    }
  }

  /** Refresh the tracked context % (and window, when the SDK reports one) and
   *  surface changes through the registry + session list. */
  private async refreshContextPercentage(): Promise<void> {
    const usage = await this.getContextUsage();
    if (!usage || !this._alive) return;
    const pct = typeof usage.percentage === 'number' && isFinite(usage.percentage)
      ? Math.max(0, Math.min(100, Math.round(usage.percentage)))
      : undefined;
    const cw = usage.contextWindow;
    let changed = false;
    const patch: { contextPercentage?: number; contextWindow?: number } = {};
    if (pct !== undefined && pct !== this.contextPercentage) {
      this.contextPercentage = pct;
      patch.contextPercentage = pct;
      changed = true;
    }
    if (cw !== undefined && cw > 0 && cw !== this.contextWindow) {
      this.contextWindow = cw;
      patch.contextWindow = cw;
      changed = true;
    }
    if (!changed) return;
    if (this._phase === 'ready') {
      await this.registry.update(this.sessionId, patch);
    }
    this.events.onStateChanged?.(this.sessionId);
  }

  // --- Git-commit detection (ported) ---

  /**
   * Reconcile this session's `committed` flag with git: flip it to true once
   * HEAD has advanced past the hash captured at session start. Returns true if
   * it changed. Called by the fast path above and the orchestrator's poll.
   */
  async detectCommit(): Promise<boolean> {
    if (!this._alive || this.committed || !this.baseHead) return false;
    const head = await this.gitHead(this.cwd);
    if (head && head !== this.baseHead) {
      this.committed = true;
      if (this._phase === 'ready') {
        await this.registry.update(this.sessionId, { committed: true });
      }
      this.events.onStateChanged?.(this.sessionId);
      return true;
    }
    return false;
  }

  /** Explicit close (phone close-session / shutdown). Does NOT emit onEnded —
   *  the orchestrator owns what happens to the registry record next. */
  async close(): Promise<void> {
    if (!this._alive) return;
    this._alive = false;
    this._phase = 'ended';
    this.broker.denyAllPending(this.sessionId, 'Session closed');
    await this.handle?.end();
    this.events.log(`[Runner] Session ${this.sessionId} closed`);
  }

  /** Re-derive the registry state (waiting_permission / waiting_question / idle / running). */
  async refreshRegistryState(): Promise<void> {
    if (this._phase !== 'ready') return;
    await this.registry.update(this.sessionId, { state: this.state() });
  }

  // --- Record building ---

  private project(): string {
    return this.projectOverride || path.basename(this.cwd) || this.cwd;
  }

  private record(): SessionRecord {
    return {
      sessionId: this.sessionId,
      sdkSessionId: this.sdkSessionId,
      ...(this.previousSdkSessionId ? { previousSdkSessionId: this.previousSdkSessionId } : {}),
      cwd: this.cwd,
      ...(this.model ? { model: this.model } : {}),
      ...(this._providerId ? { providerId: this._providerId } : {}),
      ...(this.effortLevel ? { effortLevel: this.effortLevel } : {}),
      permissionMode: this.permissionMode,
      title: this.title,
      project: this.project(),
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      state: this.state(),
      ...(this.committed ? { committed: true } : {}),
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      ...(this.contextPercentage !== undefined ? { contextPercentage: this.contextPercentage } : {}),
    };
  }
}
