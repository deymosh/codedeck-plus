/**
 * The driver interface — what an agent implements to run inside the host.
 *
 * A driver owns everything specific to its agent: starting it, translating
 * its events into transcript entries, what its modes mean, when it needs the
 * user, and how credentials and provider profiles reach it. It talks to the
 * bridge only through the `SessionContext` it is handed, never through the
 * pipe directly — the host does the framing, request ids and routing.
 *
 * Adding an agent = a folder under `drivers/` with a class implementing
 * `Driver` and a `DriverModule` registering it (`module.ts`), plus a line in
 * `host/modules.ts`; the bridge needs no change.
 */
import type {
  AgentInfo,
  AvailablePlugin,
  InstalledPlugin,
  McpAction,
  McpServerAdd,
  McpServerInfo,
  ModelEntry,
  OptionChoice,
  PermissionRequest,
  PlanOutcome,
  PluginAction,
  PluginMarketplace,
  ProviderBinding,
  QuestionOutcome,
  QuestionSpec,
  RefusedProvider,
  SelectOutcome,
  SessionEvent,
  SessionMcpServer,
  SessionOption,
  SlashCommand,
  StartSession,
  UsageData,
} from './types';
import type { EndpointModel } from './providerModels';

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
  /** Ask the user how to proceed with a finished plan. `revise` is the
   *  option that sends the plan back, when the agent has one: the user may
   *  choose it with their feedback, which arrives in the outcome. */
  requestPlanApproval(requestId: string, options: OptionChoice[], revise?: string): Promise<PlanOutcome>;
  /** A diagnostic line for the bridge log (stderr). Never pass secrets. */
  log(message: string): void;
}

export interface DriverSession {
  /** Hand user input to the agent. */
  prompt(text: string): void;
  /** Stop the running turn. Best effort. */
  interrupt(): Promise<void>;
  /** Stop one background task (a `background_task` entry's `taskId`), for
   *  an agent whose catalog entry `supports.tasks`. Its next entry says it
   *  stopped. Rejects with the agent's reason when it cannot. */
  stopTask?(taskId: string): Promise<void>;
  /** Apply a mode / effort / model change. Rejects when the agent refuses. */
  setOption(option: SessionOption, value: string): Promise<void>;
  /** Subscription usage for this session's account, if the agent has any. */
  getUsage(): Promise<UsageData | null>;
  /** The slash commands the session understands now, for an agent whose
   *  catalog entry `supports.commands`. Asked every time the phone wants
   *  them, so a list that changes while the session runs is never stale. */
  listCommands?(): Promise<SlashCommand[]>;
  /** The session's MCP servers and where each stands, for an agent whose
   *  catalog entry `supports.mcp`. */
  mcpStatus?(): Promise<SessionMcpState>;
  /** Switch one MCP server on or off in this session and answer the new
   *  status. Rejects with the agent's reason when it cannot. */
  toggleMcp?(name: string, enabled: boolean): Promise<SessionMcpState>;
  /** Stop the agent. Idempotent; no events are expected afterwards. */
  end(): Promise<void>;
}

/** An agent's plugins on this machine. `marketplaces` is absent for an
 *  agent that installs plugins by package name; `toggles`: a plugin can be
 *  switched off without uninstalling it; `available` is present only when
 *  asked for (or when the change touched a marketplace); `message` says what
 *  the last change did, in the agent's words, when it says. */
export interface PluginState {
  installed: InstalledPlugin[];
  marketplaces?: PluginMarketplace[];
  toggles: boolean;
  available?: AvailablePlugin[];
  message?: string;
}

/** For an agent whose catalog entry `supports.plugins`. */
export interface PluginManager {
  list(available: boolean): Promise<PluginState>;
  /** Apply one change and answer the new state — with `available` when the
   *  change was to a marketplace, since that alters the catalog. Rejects
   *  with the agent's own reason when the change was refused. */
  act(action: PluginAction, target: string): Promise<PluginState>;
}

/** An agent's MCP servers on this machine. `toggles`: a server can be
 *  switched off without removing it. Never carries a secret's value. */
export interface McpState {
  servers: McpServerInfo[];
  toggles: boolean;
}

/** For an agent whose catalog entry `supports.mcp`: its MCP servers, kept
 *  in the agent's own configuration so they also apply outside CodeDeck. */
export interface McpManager {
  list(): Promise<McpState>;
  /** Apply one change and answer the new state; running sessions pick it
   *  up. Rejects with the agent's own reason when it was refused. */
  act(action: McpAction, servers: McpServerAdd[], names: string[]): Promise<McpState>;
}

/** A session's MCP servers. `toggles`: they can be switched in the
 *  session; `projectWide`: a switch applies to every session of the agent
 *  in the same project. */
export interface SessionMcpState {
  servers: SessionMcpServer[];
  toggles: boolean;
  projectWide: boolean;
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
  /** Check one of this agent's provider profiles: its token, with the
   *  smallest request on the API the agent speaks to it, on `model`
   *  (`sdk/providerCheck`). True/false, or undefined when it could not be
   *  checked. */
  checkProvider?(provider: ProviderBinding, model: string): Promise<boolean | undefined>;
  /** The models a provider profile's endpoint lists, read the way this
   *  agent's API signs in (`sdk/providerApi`). Rejects with the reason
   *  there is no list. */
  listProviderModels?(baseUrl: string, token: string): Promise<EndpointModel[]>;
  /** For an agent whose catalog entry `supports.providerModels`: its
   *  provider profiles, all of them, oldest saved first, whenever one
   *  changes. Their models are offered beside the agent's own; nothing the
   *  agent already has goes. Resolves to the profiles left out (a name one
   *  of the agent's providers, or an earlier profile, already has), each
   *  with the reason in words for a person. */
  setProviders?(providers: ProviderBinding[]): Promise<RefusedProvider[]>;
  /**
   * Delete the agent's own record of a conversation (an `info`
   * `nativeSessionId` it reported, run in `cwd`): its transcript files, or
   * its session on the agent's server, with any subagent conversations it
   * spawned. Called only once the session that ran it has ended. Resolves
   * when nothing of it is left — also when there was nothing to begin with —
   * and rejects with the reason it could not. Absent: the agent keeps
   * nothing the host can remove.
   */
  deleteConversation?(conversationId: string, cwd: string): Promise<void>;
  /** Manages the agent's plugins, when it has any. */
  readonly plugins?: PluginManager;
  /** Manages the agent's MCP servers, when it supports them. */
  readonly mcp?: McpManager;
  /** Release driver-wide resources (servers it spawned). */
  shutdown?(): Promise<void>;
}
