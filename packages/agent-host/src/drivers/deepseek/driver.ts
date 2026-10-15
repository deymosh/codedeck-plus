/**
 * The DeepSeek Harness driver, over the ACP profile of the `dsh` CLI
 * (`dsh --profile acp`, runtime.ts) — the only interface the harness exposes
 * that has everything an interactive client needs: prompts, cancellation,
 * one-shot permission asks, and a model/reasoning selection that can change
 * mid-session. Its `sdk` profile has none of the last three, and `headless`
 * is one-shot.
 *
 * The ACP session lifecycle is the shared base (acp/session); what is the
 * harness's own is here: its modes and efforts, its `[provider, model]` model
 * ids, how its tool calls read (tools.ts), and the calls that ask the user.
 *
 * What ACP does not carry — the harness's slash commands, the questions its
 * model asks, and a message for the turn that is running — reaches the
 * harness through CodeDeck's own plugin in the profile (plugin.ts), over a
 * socket each process has to itself.
 *
 * Deliberate limits, all of them the ACP surface's:
 *  - no modes: the harness has none, so `ask`/`default` are this driver's own
 *    (every ask to the phone, or auto-approve);
 *  - no background tasks: the automation profile carries none;
 *  - no subscription usage: there is nothing to ask (the context meter
 *    travels as session info instead);
 *  - MCP servers are attached when the harness starts, so a session shows
 *    them but cannot switch one;
 *  - a file change is reconstructed from the call's own arguments: the
 *    harness's result update carries no diff.
 */
import type { RequestPermissionRequest, SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk';
import type { Driver, DriverSession, McpManager, PluginManager, SessionContext, SessionMcpState } from '../../sdk/driver';
import type { HttpGet, ProviderHttp } from '../../sdk/net';
import { ANTHROPIC_API, checkToken, listModels } from '../../sdk/providerApi';
import type { EndpointModel } from '../../sdk/providerModels';
import { mcpStatus as mcpStatusOf } from '../../sdk/mcp';
import { parseSlashCommand } from '../../sdk/commands';
import { PERMISSION_ALLOW, PERMISSION_DENY, now, toolLocations } from '../../sdk/tools';
import { deepseekTool } from './tools';
import type {
  AgentInfo,
  McpStatus,
  ModelEntry,
  OutputEntry,
  PermissionRequest,
  ProviderBinding,
  SessionMcpServer,
  SessionOption,
  SlashCommand,
  StartSession,
} from '../../sdk/types';
import { deepseekUpdateToEntries, type ToolCallMemory } from './adapter';
import { selectChoices, type Choice } from '../../acp/options';
import { AcpSession, type AcpSessionDeps, type AcpSessionRegistry } from '../../acp/session';
import { DEEPSEEK_API_KEY_CREDENTIAL, DEEPSEEK_API_KEY_ENV, DEEPSEEK_BASE_URL_ENV, buildDeepSeekEnv } from './env';
import { askPlugin, listSessionCommands, runSessionCommand, steerSession } from './bridge';
import { HARNESS_PLUGIN, installHarnessPlugin, QUESTION_MARKER } from './plugin';
import { ASK_USER_TOOL, installProfileTools } from './profileTools';
import { parseQuestionLine, planReviewOf, toAnswerItems, toQuestionSpecs, type PlanReview, type PushedQuestionLine } from './questions';
import { deleteDshConversation } from './conversations';
import { providerModelsUrl } from '../../sdk/providerModels';
import { syncEndpointCatalog } from './catalog';
import { DSH_LABEL } from './install';
import { DeepSeekMcp } from './mcp';
import { DeepSeekPlugins, runDshPlugin, type DshRun } from './plugins';
import { DEEPSEEK_STYLE } from './style';
import {
  DSH_PROFILE,
  DeepSeekRuntime,
  dshProfileDir,
  type DeepSeekChannel,
  type DeepSeekProcessEvents,
  type SpawnFn,
} from './runtime';

export const DEEPSEEK_AGENT_ID = 'deepseek-harness';

/** `ask` sends every permission the harness asks for to the phone; `default`
 *  (the auto-approve mode every agent shares) allows them all. */
const AUTO_APPROVE_MODE = 'default';
const DEFAULT_MODE = 'ask';
const DEEPSEEK_MODES = [
  { id: DEFAULT_MODE, label: 'Ask', description: 'Ask before each tool call' },
  { id: AUTO_APPROVE_MODE, label: 'YOLO', description: 'Run every tool without asking' },
];

/**
 * The harness's reasoning levels. They are the harness's own vocabulary and
 * are offered in `info()` because a session's options — which would say so
 * precisely — only exist once a session has started; a level this list offers
 * and the running model does not have is refused by the harness itself, with
 * its own reason.
 */
const DEEPSEEK_EFFORTS = [
  { id: 'off', label: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
  { id: 'low', label: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
  { id: 'high', label: 'High', description: 'The default balance for most tasks.' },
  { id: 'max', label: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
];
/** What the DeepSeek route runs at when nothing is chosen. */
const DEFAULT_EFFORT = 'high';

/** How long the harness waits for the phone's answer to a question before
 *  the bridge gives up on it (the harness's own waits are its business; this
 *  is only the socket round trip that carries the answer). */
const QUESTION_TIMEOUT_MS = 60_000;

/** The harness's own option ids (standard ACP session config options). */
const MODEL_CONFIG_ID = 'model';
const EFFORT_CONFIG_ID = 'reasoning_effort';

/**
 * One model as the phone sees it, in the shape the other drivers report: the
 * id is the model's own — a gateway's usually names its channel before a
 * slash (`Z.ai (Global) - Coding Plan/glm-5.3-flash`, Claude Code's gateway
 * models arrive the same way) — and the channel becomes the provider, with
 * the model part as the label. The harness's own selector value is what
 * travels back to it; `resolveModel` maps one to the other.
 */
export function toModelEntry(choice: Choice): ModelEntry {
  const id = modelIdOf(choice.value);
  const slash = id.indexOf('/');
  const channel = slash > 0 ? id.slice(0, slash) : undefined;
  const label = channel !== undefined ? id.slice(slash + 1) : choice.label;
  return {
    id,
    label,
    ...(channel !== undefined ? { provider: channel } : choice.provider ? { provider: choice.provider } : {}),
  };
}

/** The model choices of a session's option state: `value` is the opaque
 *  selector the harness sets and returns, `label` what its own name says. */
export function modelChoices(option: SessionConfigOption | undefined): Choice[] {
  return selectChoices(option);
}

/** The plain reasoning levels of a session's option state (the empty value
 *  the harness offers as "provider default" is not a level). */
export function effortChoices(option: SessionConfigOption | undefined): Choice[] {
  return selectChoices(option).filter((choice) => choice.value !== '');
}

/**
 * The model inside a selector: its value is the harness's own encoding of
 * `[provider, model]`, and a model named by a provider profile is the plain
 * id inside it. A value that is not that pair is returned as it is, so an
 * unknown encoding matches nothing rather than everything.
 */
export function modelIdOf(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === 'string') return parsed[1];
  } catch {
    // Not a selector: the value is already what it looks like.
  }
  return value;
}

/** What one DeepSeek session is built with, beyond the shared ACP base. */
interface DeepSeekSessionDeps extends AcpSessionDeps<DeepSeekChannel, DeepSeekProcessEvents> {
  runtime: DeepSeekRuntime;
  mcp: DeepSeekMcp;
  baseEnv: NodeJS.ProcessEnv;
}

export class DeepSeekSession extends AcpSession<DeepSeekChannel, DeepSeekProcessEvents, DeepSeekSessionDeps> {
  /** `ask` (every permission to the phone) or `default` (auto-approve). */
  private sessionMode: string;
  /** The names this session's harness can run, from the last list fetched
   *  (dropped again on failure, so the next look asks again). */
  private commandNames?: Promise<Set<string>>;
  /** Messages sent during the running turn, steered (or queued) one after
   *  another so they reach the model in the order they were sent. */
  private steering: Promise<unknown> = Promise.resolve();
  /** A message of this turn already waits for the next one: whatever is sent
   *  after it waits too, so it never overtakes it. */
  private queuedBehindTurn = false;

  constructor(params: StartSession, ctx: SessionContext, deps: DeepSeekSessionDeps) {
    super(params, ctx, deps);
    this.sessionMode = params.mode ?? DEFAULT_MODE;
  }

  /** Where the plugin of the process holding this session answers. Every
   *  process has its own socket, so it is always this process's. */
  private get bridgeSocket(): string | undefined {
    return this.process?.handle.socket;
  }

  // --- the ACP base's hooks ---

  protected override buildEnv(params: StartSession): Record<string, string> {
    // Built as the session is constructed, not in `init`: a provider profile
    // that cannot be used at all refuses the session before it starts, rather
    // than after an error entry the phone would have to read.
    return buildDeepSeekEnv(params, this.deps.baseEnv);
  }

  protected override translate(update: SessionUpdate, calls: ToolCallMemory): OutputEntry[] {
    return deepseekUpdateToEntries(update, calls, this.reportUnknownTool);
  }

  protected override autoApprove(): boolean {
    return this.sessionMode === AUTO_APPROVE_MODE;
  }

  /**
   * The card one permission ask becomes. The harness names only the tool
   * call, so the card comes from that call's own update — which the harness
   * sends before it asks — and the choices are the two it offers: it has no
   * "always allow" to choose.
   */
  protected override permissionCard(request: RequestPermissionRequest): Omit<PermissionRequest, 'sessionId'> {
    const callId = request.toolCall.toolCallId;
    const facts = this.calls.get(callId);
    const toolName = facts?.name ?? request.toolCall.name ?? request.toolCall.title ?? 'tool';
    const input = facts?.input ?? {};
    const locations = toolLocations(input);
    const call = deepseekTool(toolName, input, this.reportUnknownTool);
    return {
      requestId: callId,
      toolName,
      kind: call.kind,
      title: call.title,
      ...(locations.length > 0 ? { locations } : {}),
      options: [PERMISSION_ALLOW, PERMISSION_DENY],
    };
  }

  /** Apply the model and reasoning level the session was started with. The
   *  model goes first: which reasoning levels exist is the model's own. */
  protected override async applySelection(): Promise<void> {
    const wanted = this.params.model;
    if (wanted) {
      const value = this.resolveModel(wanted);
      try {
        await this.setConfig(MODEL_CONFIG_ID, value ?? wanted);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!this.params.provider) {
          // The phone chooses from this driver's own model list, so a model
          // it cannot have is a stale choice: refusing the session says so
          // loudly instead of quietly running something else.
          throw new Error(`${DSH_LABEL} does not offer the model '${wanted}': ${reason} — choose one from its model list.`);
        }
        // A provider-bound session's model names the gateway's own model,
        // while the harness sends its catalog's name on the wire and lets the
        // gateway map it: a name the catalog does not know is not fatal, but
        // the phone must not believe it took effect.
        this.deliver({
          entryType: 'error',
          text: `The provider profile's model '${wanted}' is not one the harness knows: ${reason}`,
          timestamp: now(),
        });
      }
    }
    const effort = this.params.effort;
    if (effort && effortChoices(this.optionOf(EFFORT_CONFIG_ID)).some((choice) => choice.value === effort)) {
      await this.setConfig(EFFORT_CONFIG_ID, effort);
    } else if (effort) {
      this.deliver({
        entryType: 'error',
        text: `This model has no reasoning level '${effort}' in ${DSH_LABEL} — the session runs at the model's own default.`,
        timestamp: now(),
      });
    }
  }

  protected override mode(): string {
    return this.sessionMode;
  }

  protected override modelLabel(): string | undefined {
    return this.currentModel()?.label;
  }

  protected override version(): Promise<string | undefined> {
    return this.deps.runtime.version();
  }

  // --- messages, commands and steering ---

  /**
   * A typed `/name` that this session's harness has runs as that command —
   * `listCommands` is what makes the phone offer it, and the harness's own
   * command registry is what runs it (`/compact` compacts, rather than being
   * text the model reads). Anything else is a prompt.
   */
  protected override async tryCommand(text: string): Promise<boolean> {
    const command = parseSlashCommand(text);
    if (command && (await this.knownCommands()).has(command.name)) {
      await this.runCommand(text);
      return true;
    }
    return false;
  }

  /**
   * A message sent while a turn runs: the harness's own steering, which its
   * apps use for a message sent while the agent works, through the plugin —
   * and the model reads it at its next step. A slash command is never
   * steered: it runs as the harness's own command, so it waits for the turn
   * to end like any other queued message.
   */
  protected override steer(text: string): void {
    if (parseSlashCommand(text)) {
      this.enqueue(text);
      return;
    }
    const next = this.steering.then(() => this.steerOrQueue(text));
    this.steering = next.catch(() => {});
  }

  protected override promptSettled(): void {
    this.queuedBehindTurn = false;
  }

  private async steerOrQueue(text: string): Promise<void> {
    const socket = this.bridgeSocket;
    const sessionId = this.nativeId;
    if (!this.queuedBehindTurn && this.promptInFlight && socket !== undefined && sessionId !== undefined) {
      if (await steerSession(socket, sessionId, text, this.ctx.log)) return;
    }
    this.queuedBehindTurn = true;
    this.enqueue(text);
  }

  /** Run one command line and show what it said. A command is not a turn in
   *  the harness, but the phone is waiting on one: it is opened and closed
   *  around it, so the session never sits there looking busy. */
  private async runCommand(line: string): Promise<void> {
    await this.ready;
    const sessionId = this.nativeId;
    if (this.ended || sessionId === undefined) return;
    this.ctx.emit({ type: 'turn', state: 'running' });
    const socket = this.bridgeSocket;
    const outcome = socket === undefined ? undefined : await runSessionCommand(socket, sessionId, line, this.ctx.log);
    if (this.ended) return;
    if (outcome === undefined) {
      this.deliver({ entryType: 'error', text: `${line} did not run: the command bridge is not answering.`, timestamp: now() });
    } else if (outcome.text !== '') {
      this.deliver({
        ...(outcome.ok
          ? { entryType: 'text' as const, role: 'agent' as const, text: outcome.text }
          : { entryType: 'error' as const, text: outcome.text }),
        timestamp: now(),
      });
    } else if (!outcome.ok) {
      this.deliver({ entryType: 'error', text: `${line} failed.`, timestamp: now() });
    }
    this.endTurn();
  }

  /**
   * What this session's harness can run, asked of the harness itself (the
   * command plugin) and cached until the session ends once it has been
   * read. A list that could not be read is asked for again next time — the
   * plugin may simply not be answering yet — and meanwhile every slash line
   * is ordinary text, which is what a harness without the plugin does.
   */
  private knownCommands(): Promise<Set<string>> {
    this.commandNames ??= this.ready
      .then(() => this.sessionCommands())
      .then((commands) => {
        if (commands === undefined) this.commandNames = undefined;
        return new Set((commands ?? []).map((command) => command.name));
      })
      .catch(() => {
        this.commandNames = undefined;
        return new Set<string>();
      });
    return this.commandNames;
  }

  /** The session's commands as its harness lists them, or `undefined` when
   *  the plugin cannot be asked. */
  private async sessionCommands(): Promise<SlashCommand[] | undefined> {
    const socket = this.bridgeSocket;
    const sessionId = this.nativeId;
    if (socket === undefined || sessionId === undefined) return undefined;
    return listSessionCommands(socket, sessionId, this.ctx.log);
  }

  async listCommands(): Promise<SlashCommand[]> {
    await this.ready;
    if (this.ended) return [];
    return (await this.sessionCommands()) ?? [];
  }

  // --- the questions the model asks ---

  /**
   * The harness's model asked the user something, and the plugin pushed it
   * here. A question goes to the phone as the same card the other agents send,
   * and the answer goes back the way the harness takes it — labels for a
   * chosen option, free text for a typed one. An unanswered question (the
   * phone is gone, the user cancelled, the turn ended) is answered with
   * nothing, which the harness reports to the model as a question that was
   * not answered.
   */
  askQuestion(pushed: PushedQuestionLine): void {
    const review = planReviewOf(pushed.questions);
    void (review === undefined ? this.showQuestion(pushed) : this.showPlanReview(pushed, review)).catch((error: unknown) => {
      this.ctx.log(`[deepseek] could not pass a question on: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async showQuestion(pushed: PushedQuestionLine): Promise<void> {
    const outcome = await this.ctx.askQuestion(pushed.callId, toQuestionSpecs(pushed.questions));
    await this.answerHarness(pushed.callId, {
      ...(outcome.outcome === 'answered' ? { answer: toAnswerItems(pushed.questions, outcome.answers) } : {}),
    });
  }

  /**
   * A plan review is the harness's `exit_plan_mode` asking whether to leave
   * plan mode. It is the same exchange Claude Code's driver has — a plan the
   * user reads and then approves or sends back — so it gets the same two
   * pieces on the phone: the plan as a plan of its own, and the approval card,
   * whose choices are the harness's own labels because that is what the tool
   * reads its verdict from. Feedback on a plan the user sends back goes with
   * that choice, as the answer's free text — where the harness's tool reads
   * it and hands it to the model with the request to revise.
   */
  private async showPlanReview(pushed: PushedQuestionLine, review: PlanReview): Promise<void> {
    this.deliver({ entryType: 'plan', text: review.plan, timestamp: now() });
    const outcome = await this.ctx.requestPlanApproval(pushed.callId, review.options, review.revise);
    if (outcome.outcome !== 'selected') {
      await this.answerHarness(pushed.callId, {});
      return;
    }
    const feedback = outcome.optionId === review.revise ? outcome.feedback?.trim() : undefined;
    await this.answerHarness(pushed.callId, {
      // The chosen label is the whole verdict: the tool looks for the one its
      // intent declared as the approval.
      answer: [{ id: review.id, selected: [outcome.optionId], ...(feedback ? { custom: feedback } : {}) }],
    });
  }

  /** What the phone decided, back to the harness: the plugin is holding the
   *  ask open, and an answer it is not given is one the user did not make. */
  private async answerHarness(callId: string, answer: Record<string, unknown>): Promise<void> {
    const socket = this.bridgeSocket;
    if (socket === undefined) return;
    await askPlugin(socket, { method: 'answer', sessionId: this.nativeId, callId, ...answer }, QUESTION_TIMEOUT_MS, this.ctx.log);
  }

  // --- the model and the session's own state ---

  /**
   * The value to select for a model the bridge names. Two shapes reach here:
   * the model id this driver reports (what the phone was shown, and what a
   * provider profile names), and the harness's own selector value. Anything
   * else matches nothing, so it is refused rather than guessed at.
   */
  private resolveModel(model: string): string | undefined {
    const choices = modelChoices(this.optionOf(MODEL_CONFIG_ID));
    return (
      choices.find((choice) => choice.value === model)?.value ?? choices.find((choice) => modelIdOf(choice.value) === model)?.value
    );
  }

  /** The model the session is on, as its option state describes it. */
  private currentModel(): Choice | undefined {
    const option = this.optionOf(MODEL_CONFIG_ID);
    if (!option || option.type !== 'select') return undefined;
    return (
      modelChoices(option).find((choice) => choice.value === option.currentValue) ?? {
        value: option.currentValue,
        label: option.currentValue,
      }
    );
  }

  override async setOption(option: SessionOption, value: string): Promise<void> {
    switch (option) {
      case 'mode':
        if (!DEEPSEEK_MODES.some((mode) => mode.id === value)) throw new Error(`${DSH_LABEL} has no mode '${value}'`);
        this.sessionMode = value;
        return;
      case 'model': {
        // The harness answers a change with the complete option list, so the
        // model it actually took is read back from there: the phone is told
        // only when it differs from what it had.
        const before = this.currentModel()?.value;
        await this.setConfig(MODEL_CONFIG_ID, this.resolveModel(value) ?? value);
        const after = this.currentModel();
        if (this.announced && after && after.value !== before) this.ctx.emit({ type: 'info', model: after.label });
        return;
      }
      case 'effort':
        await this.setConfig(EFFORT_CONFIG_ID, value);
        return;
    }
  }

  /**
   * The session's MCP servers. The harness reads them when it starts, so
   * this reports what the running process has: a server configured after it
   * started is not in it yet, and a server the harness complained about
   * (on stderr — the only place it says so) is the one failure it reports.
   */
  async mcpStatus(): Promise<SessionMcpState> {
    const state = await this.deps.mcp.list();
    const process_ = this.process;
    const failures = process_?.handle.failures ?? new Map<string, string>();
    const configured = this.deps.mcp.version;
    const loaded = process_?.configVersion ?? Number.POSITIVE_INFINITY;
    const servers: SessionMcpServer[] = state.servers.map((server) => {
      const failure = failures.get(server.name);
      // The harness's own word first: a server it complained about has no
      // tools, whatever the configuration says. Then a configuration this
      // process was not started with, which it therefore has not loaded.
      const status: McpStatus = !server.enabled
        ? 'disabled'
        : failure
          ? mcpStatusOf('failed')
          : process_?.alive !== true || configured > loaded
            ? 'pending'
            : 'connected';
      return { name: server.name, status, ...(failure ? { error: failure } : {}) };
    });
    return { servers, toggles: false, projectWide: false };
  }

  async toggleMcp(name: string, enabled: boolean): Promise<SessionMcpState> {
    void name;
    void enabled;
    throw new Error(
      `${DSH_LABEL} attaches its MCP servers when it starts, so a running session cannot switch one. ` +
        'Change it in the MCP list: the next session uses the new set.',
    );
  }
}

export interface DeepSeekDriverOptions {
  /** The runtime that owns the harness processes. */
  runtime: DeepSeekRuntime;
  /** `$DSH_HOME` — where the harness's profiles and sessions live. */
  home: string;
  /** The MCP manager over that home's profile layer. The runtime is told to
   *  watch its version, so the process and the manager share one instance. */
  mcp?: DeepSeekMcp;
  /** The environment this driver's own probe inherits (the host's). */
  baseEnv?: NodeJS.ProcessEnv;
  /** HTTPS client for the credential check. */
  httpGet?: HttpGet;
  /** Outbound HTTP to provider profiles' endpoints. */
  providerHttp?: ProviderHttp;
  /** Spawn seam for the plugin commands, for tests. */
  spawnFn?: SpawnFn;
  log: (message: string) => void;
}

export class DeepSeekDriver implements Driver {
  readonly mcp: DeepSeekMcp;
  readonly plugins: PluginManager;
  private unavailable: string | undefined;
  private models?: Promise<{ models: ModelEntry[]; defaultModel?: string }>;
  /**
   * Everything that has to be true of the harness's profile before a process
   * starts: the gateway's catalog (a process reads its catalog once, as it
   * boots) and the command bridge (a process mounts its plugins once, too).
   * Sessions and the model probe wait for it.
   */
  private prepared: Promise<unknown> = Promise.resolve();
  /** Sessions by the harness's own ids: a process serves several, and it is
   *  this map that ends them all when it goes away. */
  private readonly sessions = new Map<string, AcpSession<DeepSeekChannel, DeepSeekProcessEvents>>();
  private readonly live: AcpSessionRegistry<DeepSeekChannel, DeepSeekProcessEvents> = {
    events: (): DeepSeekProcessEvents => ({
      ended: (sessionIds: readonly string[], error: string) => {
        for (const sessionId of sessionIds) this.sessions.get(sessionId)?.endFromProcess(error);
      },
      question: (line: string) => {
        const pushed = parseQuestionLine(line, QUESTION_MARKER);
        if (pushed?.sessionId === undefined) return;
        // Only this driver's sessions ever register, so the narrowed type is
        // the one its own updates are routed by.
        const session = this.sessions.get(pushed.sessionId);
        if (session instanceof DeepSeekSession) session.askQuestion(pushed);
      },
    }),
    add: (sessionId: string, session: AcpSession<DeepSeekChannel, DeepSeekProcessEvents>): void => {
      this.sessions.set(sessionId, session);
    },
    remove: (sessionId: string): void => {
      this.sessions.delete(sessionId);
    },
  };

  private constructor(private readonly options: DeepSeekDriverOptions) {
    const profileDir = dshProfileDir(options.home);
    this.mcp = options.mcp ?? new DeepSeekMcp({ profileDir, log: options.log });
    this.plugins = new DeepSeekPlugins({
      profileDir,
      run: (args) => this.runDsh(args),
      packagesDir: () => options.runtime.packagesRoot(),
      log: options.log,
    });
  }

  static create(options: DeepSeekDriverOptions): DeepSeekDriver {
    const driver = new DeepSeekDriver(options);
    // The runtime is fetched as the host starts, like the other agents', so
    // the first session (and the model list the phone asks for before it)
    // finds it ready instead of waiting on a download.
    void options.runtime.prepare();
    driver.prepared = driver.prepareProfile();
    return driver;
  }

  /** Everything the profile needs before a harness boots (once, at the
   *  start): the endpoint's catalog, and CodeDeck's own rows in its patch
   *  layer. */
  private async prepareProfile(): Promise<void> {
    await this.syncCatalog();
    await this.ownProfile();
  }

  /**
   * Put CodeDeck's part of the profile in place: the plugin that carries the
   * harness's commands and questions out to the phone, and the tool rows the
   * profile's own bundles leave out. Each is independent and each failure
   * costs only itself: it is logged, and the session runs on.
   */
  private async ownProfile(): Promise<void> {
    const profileDir = dshProfileDir(this.options.home);
    try {
      await installHarnessPlugin(profileDir, this.options.log);
    } catch (error) {
      this.options.log(`[deepseek] could not install the command bridge: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await installProfileTools(profileDir, this.options.log);
    } catch (error) {
      this.options.log(
        `[deepseek] could not mount ${ASK_USER_TOOL}, so the model has no question tool: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Point the harness at the operator's endpoint, with the models that
   * endpoint serves (catalog.ts): without this a session on another
   * endpoint would be sent a DeepSeek model name it does not know, and the phone
   * would offer models that are not there.
   */
  private async syncCatalog(): Promise<void> {
    const env = this.options.baseEnv ?? process.env;
    try {
      await syncEndpointCatalog(
        { profileDir: dshProfileDir(this.options.home), log: this.options.log, ...(this.options.httpGet ? { httpGet: this.options.httpGet } : {}) },
        env[DEEPSEEK_BASE_URL_ENV]?.trim() || undefined,
        env[DEEPSEEK_API_KEY_ENV]?.trim() || undefined,
      );
    } catch (error) {
      // The catalog is a convenience, never a reason to refuse to run: the
      // harness's own models still work.
      this.options.log(`[deepseek] could not write the endpoint's catalog: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Mark the driver unusable (a path the operator named is not a file). */
  setUnavailable(reason: string): void {
    this.unavailable = reason;
  }

  info(): AgentInfo {
    return {
      id: DEEPSEEK_AGENT_ID,
      displayName: DSH_LABEL,
      modes: DEEPSEEK_MODES,
      efforts: DEEPSEEK_EFFORTS,
      defaultMode: DEFAULT_MODE,
      defaultEffort: DEFAULT_EFFORT,
      // What the harness's automation profile carries, and what it does not:
      // no slash commands, no background tasks, no subscription usage. Its
      // plugins and MCP servers are its own configuration files, which this
      // driver reads and writes.
      supports: {
        models: true,
        usage: false,
        providers: true,
        interrupt: true,
        // Through the plugin this driver installs into the profile
        // (plugin.ts): the harness's command registry is reachable from
        // inside its process, never over ACP.
        commands: true,
        plugins: true,
        mcp: true,
        tasks: false,
      },
      credentials: [{ id: DEEPSEEK_API_KEY_CREDENTIAL, label: 'DeepSeek API key', envVar: 'DEEPSEEK_API_KEY' }],
      style: DEEPSEEK_STYLE,
      ...(this.unavailable ? { unavailableReason: this.unavailable } : {}),
    };
  }

  startSession(params: StartSession, ctx: SessionContext): DriverSession {
    if (this.unavailable) throw new Error(this.unavailable);
    if (params.mode !== undefined && !DEEPSEEK_MODES.some((mode) => mode.id === params.mode)) {
      throw new Error(`${DSH_LABEL} has no mode '${params.mode}'`);
    }
    return new DeepSeekSession(params, ctx, {
      runtime: this.options.runtime,
      mcp: this.mcp,
      baseEnv: this.options.baseEnv ?? process.env,
      live: this.live,
      prepared: this.prepared,
      tag: 'deepseek',
      label: DSH_LABEL,
    });
  }

  /**
   * The harness's model catalog, from a short-lived probe session: the option
   * state a session starts with is where its catalog lives, and reading it
   * needs neither a credential nor a reachable endpoint (it is the profile's
   * own, declarative list). Cached once it says something, and asked again
   * after a failure or an empty answer — an empty catalog is not a catalog.
   */
  listModels(): Promise<{ models: ModelEntry[]; defaultModel?: string }> {
    this.models ??= this.probeModels().catch((error: unknown) => {
      this.models = undefined;
      this.options.log(`[deepseek] could not list models: ${error instanceof Error ? error.message : String(error)}`);
      return { models: [] };
    });
    return this.models;
  }

  private async probeModels(): Promise<{ models: ModelEntry[]; defaultModel?: string }> {
    await this.prepared;
    const env = buildDeepSeekEnv({}, this.options.baseEnv ?? process.env);
    const process_ = await this.options.runtime.acquire(env, { ended: () => {} });
    try {
      const opened = await process_.client.request('session/new', { cwd: this.options.home, mcpServers: [] });
      const option = (opened.configOptions ?? []).find((entry) => entry.id === MODEL_CONFIG_ID);
      const choices = modelChoices(option);
      const models: ModelEntry[] = choices.map(toModelEntry);
      if (models.length === 0) this.models = undefined;
      // The probe's own conversation is disposed of; nothing of it survives
      // but an empty session record in the harness's home.
      await process_.client.request('session/close', { sessionId: opened.sessionId }).catch(() => {});
      const current = choices.find((choice) => choice.value === option?.currentValue);
      return {
        models,
        ...(current ? { defaultModel: toModelEntry(current).id } : {}),
      };
    } finally {
      process_.release();
    }
  }

  /**
   * Check the key against the endpoint it is for: the operator's endpoint
   * when one is configured (its `/models` is the one call every endpoint has
   * in common — the same one this driver reads the catalog from), else the
   * DeepSeek API. A refusal is a refusal; anything else says nothing.
   */
  async checkCredential(credential: string, value: string): Promise<boolean | undefined> {
    if (credential !== DEEPSEEK_API_KEY_CREDENTIAL || !this.options.httpGet) return undefined;
    const baseEnv = this.options.baseEnv ?? process.env;
    const base = baseEnv[DEEPSEEK_BASE_URL_ENV]?.trim();
    try {
      const res = await this.options.httpGet(base ? providerModelsUrl(base) : 'https://api.deepseek.com/models', {
        authorization: `Bearer ${value}`,
      });
      return res.status !== 401 && res.status !== 403;
    } catch {
      return undefined;
    }
  }

  /** The harness reaches a profile's endpoint through its DeepSeek route,
   *  which speaks Anthropic's Messages API under the endpoint's `/v1`. */
  async checkProvider(provider: ProviderBinding, model: string): Promise<boolean | undefined> {
    return this.options.providerHttp ? checkToken(ANTHROPIC_API, provider, model, this.options.providerHttp.post) : undefined;
  }

  async listProviderModels(baseUrl: string, token: string): Promise<EndpointModel[]> {
    if (!this.options.providerHttp) throw new Error('this host reads no provider endpoints');
    return listModels(ANTHROPIC_API, baseUrl, token, this.options.providerHttp.get);
  }

  deleteConversation(conversationId: string): Promise<void> {
    return deleteDshConversation(this.options.home, conversationId);
  }

  /**
   * One `dsh plugin` invocation, through the same CLI the sessions run. It
   * runs pnpm in the profile, whose `node_modules` also holds CodeDeck's own
   * plugin — a package no lockfile lists, which an install is free to prune —
   * so CodeDeck's part of the profile is put back after every run.
   */
  private async runDsh(args: string[]): Promise<DshRun> {
    const entry = await this.options.runtime.entryPoint();
    try {
      return this.options.spawnFn === undefined
        ? await runDshPlugin(entry, this.options.home, DSH_PROFILE, args)
        : await runDshPlugin(entry, this.options.home, DSH_PROFILE, args, this.options.spawnFn);
    } finally {
      await this.ownProfile();
    }
  }

  async shutdown(): Promise<void> {
    await this.options.runtime.close();
  }
}
