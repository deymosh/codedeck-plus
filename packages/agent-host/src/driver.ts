/**
 * The driver interface — what an agent implements to run inside the host.
 *
 * A driver owns everything specific to its agent: starting it, translating
 * its events into transcript entries, what its modes mean, when it needs the
 * user, and how credentials and provider profiles reach it. It talks to the
 * bridge only through the `SessionContext` it is handed, never through the
 * pipe directly — the host does the framing, request ids and routing.
 *
 * Adding an agent = one class implementing `Driver` plus a line in
 * `main.ts`; the bridge needs no change.
 */
import type {
  AgentInfo,
  ModelEntry,
  OptionChoice,
  PermissionRequest,
  QuestionOutcome,
  QuestionSpec,
  SelectOutcome,
  SessionEvent,
  SessionOption,
  StartSession,
  UsageData,
} from './types';

/** What a running session can do toward the bridge. */
export interface SessionContext {
  readonly sessionId: string;
  /** Report a session event. Anything emitted after `ended` is dropped. */
  emit(event: SessionEvent): void;
  /** Ask the user to allow a tool call. Resolves with their choice, or
   *  `cancelled` (timed out, interrupted, session ending). */
  requestPermission(request: Omit<PermissionRequest, 'sessionId'>): Promise<SelectOutcome>;
  /** Ask the user one or more questions. */
  askQuestion(requestId: string, questions: QuestionSpec[]): Promise<QuestionOutcome>;
  /** Ask the user how to proceed with a finished plan. */
  requestPlanApproval(requestId: string, options: OptionChoice[]): Promise<SelectOutcome>;
  /** Run one of the session's host tools (implemented by the bridge). */
  callHostTool(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** A diagnostic line for the bridge log (stderr). Never pass secrets. */
  log(message: string): void;
}

export interface DriverSession {
  /** Hand user input to the agent. */
  prompt(text: string): void;
  /** Stop the running turn. Best effort. */
  interrupt(): Promise<void>;
  /** Apply a mode / effort / model change. Rejects when the agent refuses. */
  setOption(option: SessionOption, value: string): Promise<void>;
  /** Subscription usage for this session's account, if the agent has any. */
  getUsage(): Promise<UsageData | null>;
  /** Stop the agent. Idempotent; no events are expected afterwards. */
  end(): Promise<void>;
}

export interface Driver {
  /** How this agent is advertised. Read once, at `initialize`. */
  info(): AgentInfo;
  /**
   * Start (or resume) a session. Returns at once; progress arrives through
   * `ctx.emit` — `ready` when it accepts prompts, `ended` when it is gone.
   * Throws only when the session cannot even begin (bad parameters).
   */
  startSession(params: StartSession, ctx: SessionContext): DriverSession;
  listModels(): Promise<{ models: ModelEntry[]; defaultModel?: string }>;
  /** Check a credential value with its provider: true/false, or undefined
   *  when it could not be checked. */
  checkCredential?(credential: string, value: string): Promise<boolean | undefined>;
  /** Release driver-wide resources (servers it spawned). */
  shutdown?(): Promise<void>;
}
