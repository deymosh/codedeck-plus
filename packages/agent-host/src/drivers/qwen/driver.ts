/**
 * The Qwen Code driver, over the CLI's ACP profile (`qwen --acp`,
 * runtime.ts) — the surface that carries everything an interactive client
 * needs: prompts, cancellation, permission asks, a plan review, its question
 * form, modes, a model selection and slash commands.
 *
 * The ACP session lifecycle is the shared base (acp/session); what is Qwen
 * Code's own is here: its modes and reasoning levels, its model selection
 * (which goes through `session/set_config_option`, since a provider profile
 * names a model and Qwen Code serves it as `<model>(openai)`), the three
 * exchanges that arrive as permission asks (a tool approval, its question
 * form, its plan review), its slash commands and the mid-turn queue that
 * carries a message into a running turn.
 *
 * Deliberate limits:
 *  - no subscription usage: ACP carries none (the context meter travels as
 *    session info instead);
 *  - no plugins and no MCP manager: both are Qwen Code's own configuration
 *    files, which this driver does not read or write;
 *  - a file change's diff is shown when the agent asks about it: Qwen Code
 *    reports a diff as the permission request's own content, not with the
 *    result, and its completed call carries text only.
 */
import type { RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk';
import type { Driver, DriverSession, SessionContext } from '../../sdk/driver';
import type { ProviderHttp } from '../../sdk/net';
import { checkToken, listModels, OPENAI_API } from '../../sdk/providerApi';
import type { EndpointModel } from '../../sdk/providerModels';
import { parseSlashCommand, slashCommand } from '../../sdk/commands';
import { now, toolLocations } from '../../sdk/tools';
import type {
  AgentInfo,
  ModelEntry,
  OutputEntry,
  PermissionRequest,
  ProviderBinding,
  QuestionReply,
  QuestionSpec,
  RefusedProvider,
  SessionOption,
  SlashCommand,
  StartSession,
  ToolKind,
} from '../../sdk/types';
import { selectChoices } from '../../acp/options';
import { AcpSession, type AcpSessionDeps, type AcpSessionRegistry } from '../../acp/session';
import type { AcpProcessEvents } from '../../acp/runtime';
import type { ToolCallMemory } from '../../acp/adapter';
import { MAX_DIFF_LINES, toDiffLines } from '../../sdk/transcript';
import { qwenUpdateToEntries } from './adapter';
import { deleteQwenConversation } from './conversations';
import { qwenProviderEnv, qwenSettingsKey, writeQwenSettings } from './settings';
import { qwenTool } from './tools';
import { QWEN_LABEL } from './install';
import { QwenRuntime } from './runtime';

export const QWEN_AGENT_ID = 'qwen-code';

/** Qwen Code's own approval modes, as its `session/new` lists them. `default`
 *  ("Default") is the one that asks before a tool call, and the one a session
 *  starts in. */
const DEFAULT_MODE = 'default';
/** The mode that runs every tool without asking. */
const AUTO_APPROVE_MODE = 'yolo';
const QWEN_MODES = [
  { id: DEFAULT_MODE, label: 'Ask', description: 'Ask before each tool call' },
  { id: 'auto-edit', label: 'Auto edit', description: 'Automatically approve file edits' },
  { id: 'plan', label: 'Plan', description: 'Analyze only, do not modify files or execute commands' },
  { id: 'auto', label: 'Auto', description: 'An LLM classifier approves what it judges safe' },
  { id: AUTO_APPROVE_MODE, label: 'YOLO', description: 'Run every tool without asking' },
];

/** Qwen Code's reasoning levels. The `default` value it also offers is not a
 *  level — it means "the model or provider default" — so it is not listed;
 *  a session with no effort chosen keeps it. */
const QWEN_EFFORTS = [
  { id: 'none', label: 'Off', description: 'Disable thinking for this session.' },
  { id: 'low', label: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
  { id: 'medium', label: 'Medium', description: 'A middle tier between low and high.' },
  { id: 'high', label: 'High', description: 'The default balance for most tasks.' },
  { id: 'xhigh', label: 'Extra high', description: 'For hard tasks that need more thinking.' },
  { id: 'max', label: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
];

/** The session config option ids Qwen Code's own state uses. */
const MODEL_CONFIG_ID = 'model';
const EFFORT_CONFIG_ID = 'reasoning_effort';

/** The extension request Qwen Code sends before a tool batch, offering the
 *  client the messages a user typed while the turn ran. */
const MID_TURN_DRAIN_METHOD = 'craft/drainMidTurnQueue';

/** What one Qwen Code session is built with, beyond the shared ACP base. */
interface QwenSessionDeps extends AcpSessionDeps<undefined, AcpProcessEvents> {
  runtime: QwenRuntime;
  /** The environment the host runs with (its own variables taken out). */
  baseEnv: NodeJS.ProcessEnv;
  /** The provider profiles the driver currently holds — read at spawn, so a
   *  session's process gets the tokens the settings file names. */
  providers: () => ProviderBinding[];
}

export class QwenSession extends AcpSession<undefined, AcpProcessEvents, QwenSessionDeps> {
  /** Qwen Code's own mode id (`default`, `plan`, `yolo`, …). */
  private sessionMode: string;
  /** The slash commands the agent last listed, by name. */
  private commands: SlashCommand[] = [];
  /** Messages typed while a turn ran, waiting for the agent's next drain. */
  private readonly midTurn: string[] = [];

  constructor(params: StartSession, ctx: SessionContext, deps: QwenSessionDeps) {
    super(params, ctx, deps);
    this.sessionMode = params.mode ?? DEFAULT_MODE;
  }

  // --- the ACP base's hooks ---

  protected override buildEnv(params: StartSession): Record<string, string> {
    const env = inherited(this.deps.baseEnv);
    // The profile tokens, under the names settings.json refers to, and a
    // fingerprint of the settings themselves: the runtime keys its process
    // pool by the environment, and a process reads settings.json as it boots,
    // so a changed provider list has to be a different environment.
    const providers = this.deps.providers();
    Object.assign(env, qwenProviderEnv(providers), { CODEDECK_QWEN_SETTINGS: qwenSettingsKey(providers) });
    Object.assign(env, params.env ?? {});
    return env;
  }

  protected override translate(update: SessionUpdate, calls: ToolCallMemory): OutputEntry[] {
    if (update.sessionUpdate === 'available_commands_update') {
      this.commands = update.availableCommands.map((command) =>
        slashCommand(command.name, command.description, commandHint(command.input)),
      );
      return [];
    }
    return qwenUpdateToEntries(update, calls, this.reportUnknownTool);
  }

  protected override autoApprove(): boolean {
    return this.sessionMode === AUTO_APPROVE_MODE;
  }

  /**
   * The card one permission ask becomes: the tool call the agent named, read
   * through this driver's table, with the choices the agent itself offered
   * (Allow once, Allow All Edits, Always Allow in project, Reject) — the
   * phone's answer is one of those ids, so nothing has to be mapped.
   */
  protected override permissionCard(request: RequestPermissionRequest): Omit<PermissionRequest, 'sessionId'> {
    const call = request.toolCall;
    const name = toolNameOf(call);
    const input = record(call.rawInput);
    const read = qwenTool(name, input, this.reportUnknownTool);
    const title = read.title === name && typeof call.title === 'string' && call.title !== '' ? call.title : read.title;
    const kind: ToolKind = read.kind !== 'other' ? read.kind : ((call.kind as ToolKind | undefined) ?? 'other');
    const locations = toolLocations(input);
    return {
      requestId: call.toolCallId,
      toolName: name,
      kind,
      title,
      ...(locations.length > 0 ? { locations } : {}),
      options: request.options.map((option) => ({ id: option.optionId, label: option.name, kind: option.kind })),
    };
  }

  /**
   * One permission ask, in whichever of its three shapes Qwen Code sent it.
   * The two that are not a plain tool approval carry the exchange in the ask
   * itself: a question form (`_meta.qwenInteractionKind`) whose answers travel
   * beside the outcome, and the plan review `exit_plan_mode` presents.
   */
  protected override async answerPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.showPermissionDiff(request);
    if (isQuestion(request)) return this.answerQuestion(request);
    if (toolNameOf(request.toolCall) === 'exit_plan_mode') return this.answerPlan(request);
    return this.answerToolCall(request);
  }

  /**
   * Apply the mode, the model and the reasoning level the session was started
   * with. The mode goes first: Qwen Code starts every session in `auto`, and
   * a session that asked for another one is switched before it accepts a
   * prompt. The model is what the phone chose from the provider profiles.
   */
  protected override async applySelection(): Promise<void> {
    const mode = this.params.mode ?? DEFAULT_MODE;
    if (this.modeState()?.currentModeId !== mode) {
      try {
        await this.setMode(mode);
      } catch (error) {
        this.deliver({
          entryType: 'error',
          text: `${QWEN_LABEL} could not switch to the '${mode}' mode: ${reason(error)}`,
          timestamp: now(),
        });
      }
    }
    const wanted = this.params.model;
    if (wanted) {
      const value = this.resolveModel(wanted);
      if (value === undefined) {
        throw new Error(`${QWEN_LABEL} does not offer the model '${wanted}' — choose one from its model list.`);
      }
      await this.setConfig(MODEL_CONFIG_ID, value);
    }
    const effort = this.params.effort;
    if (effort && effortChoices(this.optionOf(EFFORT_CONFIG_ID)).some((choice) => choice.value === effort)) {
      await this.setConfig(EFFORT_CONFIG_ID, effort);
    } else if (effort) {
      this.deliver({
        entryType: 'error',
        text: `This model has no reasoning level '${effort}' in ${QWEN_LABEL} — the session runs at the model's own default.`,
        timestamp: now(),
      });
    }
  }

  protected override mode(): string {
    return this.sessionMode;
  }

  /** The agent switched its own mode (leaving plan mode after an approval):
   *  the identity the phone shows follows it. */
  protected override modeChanged(modeId: string): void {
    this.sessionMode = modeId;
  }

  protected override modelLabel(): string | undefined {
    return this.currentModel()?.label;
  }

  /** Qwen Code's version, which its `initialize` reports truthfully (unlike
   *  the DeepSeek Harness's placeholder). */
  protected override version(): Promise<string | undefined> {
    const version = this.process?.agentInfo?.version;
    return Promise.resolve(typeof version === 'string' && version !== '' ? version : undefined);
  }

  // --- commands ---

  /**
   * The commands Qwen Code listed for this session. A typed `/name` runs as
   * the agent's own command because it is sent as the prompt verbatim — the
   * agent's session parses it — so this list is what the phone offers, not a
   * table the driver routes by.
   */
  async listCommands(): Promise<SlashCommand[]> {
    await this.ready;
    if (this.ended) return [];
    return this.commands;
  }

  // --- the mid-turn queue ---

  /**
   * A message sent while a turn runs. Qwen Code's own steering is the drain
   * request it sends before every tool batch: the message is held until then
   * and handed over as that request's answer, which the model reads inside
   * the turn. A slash line is never steered — it runs as the agent's own
   * command, so it waits for the turn to end like any other queued message.
   */
  protected override steer(text: string): void {
    if (parseSlashCommand(text)) {
      this.enqueue(text);
      return;
    }
    this.midTurn.push(text);
  }

  /** A turn ended: anything the agent never drained runs as the next turn,
   *  rather than sitting in the queue forever. */
  protected override promptSettled(): void {
    if (this.midTurn.length === 0) return;
    const queued = this.midTurn.splice(0);
    for (const text of queued) this.enqueue(text);
  }

  /** Qwen Code's extension requests. The drain is the only one this driver
   *  answers; every other unknown method stays unclaimed, and the client
   *  refuses it with `-32601` at once. */
  protected override async handleExtRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method !== MID_TURN_DRAIN_METHOD) return undefined;
    if (params.sessionId !== this.nativeId) return undefined;
    // Answered from an in-memory queue, so it must resolve at once: the agent
    // waits two seconds and latches the drain off after three timeouts.
    return { messages: this.midTurn.splice(0) };
  }

  // --- the model and the session's own state ---

  /** The value to select for a model the bridge names: Qwen Code serves a
   *  provider entry's model as `<id>(openai)`, so the profile's own id is
   *  matched against that value's model part. */
  private resolveModel(model: string): string | undefined {
    return selectChoices(this.optionOf(MODEL_CONFIG_ID)).find((choice) => choice.value === model || choice.value.startsWith(`${model}(`))
      ?.value;
  }

  /** The model the session is on, as its option state describes it. */
  private currentModel(): { value: string; label: string } | undefined {
    const option = this.optionOf(MODEL_CONFIG_ID);
    if (!option || option.type !== 'select') return undefined;
    const choice = selectChoices(option).find((entry) => entry.value === option.currentValue);
    return choice ?? { value: option.currentValue, label: option.currentValue };
  }

  override async setOption(option: SessionOption, value: string): Promise<void> {
    switch (option) {
      case 'mode': {
        if (!QWEN_MODES.some((mode) => mode.id === value)) throw new Error(`${QWEN_LABEL} has no mode '${value}'`);
        await this.setMode(value);
        this.sessionMode = value;
        return;
      }
      case 'model': {
        const before = this.currentModel()?.value;
        const resolved = this.resolveModel(value);
        if (resolved === undefined) throw new Error(`${QWEN_LABEL} does not offer the model '${value}'`);
        await this.setConfig(MODEL_CONFIG_ID, resolved);
        const after = this.currentModel();
        if (this.announced && after && after.value !== before) this.ctx.emit({ type: 'info', model: after.label });
        return;
      }
      case 'effort':
        await this.setConfig(EFFORT_CONFIG_ID, value);
        return;
      default:
        throw new Error(`${QWEN_LABEL} has no '${option}' option`);
    }
  }

  // --- the three permission shapes ---

  /**
   * A plain tool approval: the card the driver built, answered with the id of
   * whichever of the agent's own choices the user picked. An ask nobody
   * answered is cancelled, not a refusal.
   */
  private async answerToolCall(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const allow = request.options.find((option) => option.kind === 'allow_once') ?? request.options.find((option) => option.kind === 'allow_always');
    if (this.ended || !allow) return { outcome: { outcome: 'cancelled' } };
    if (this.autoApprove()) return { outcome: { outcome: 'selected', optionId: allow.optionId } };

    const outcome = await this.ctx.requestPermission(this.permissionCard(request));
    if (outcome.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } };
    // The card's choices ARE the agent's options, so a choice the agent did
    // not offer is stale and refused rather than sent back.
    if (!request.options.some((option) => option.optionId === outcome.optionId)) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: outcome.optionId } };
  }

  /**
   * The agent's question form, which arrives as a permission ask. It becomes
   * the phone's question card, and the answers travel back beside the outcome
   * — keyed by the question's position, which is the shape the tool reads.
   */
  private async answerQuestion(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const questions = questionSpecsOf(request);
    const submit = request.options.find((option) => option.kind === 'allow_once');
    if (this.ended || !submit || questions.length === 0) return { outcome: { outcome: 'cancelled' } };

    const outcome = await this.ctx.askQuestion(request.toolCall.toolCallId, questions);
    if (outcome.outcome !== 'answered') {
      const cancel = request.options.find((option) => option.kind === 'reject_once');
      return cancel ? { outcome: { outcome: 'selected', optionId: cancel.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    // The answers ride beside the outcome, which is the shape Qwen Code's
    // question tool reads (`RequestPermissionResponse` does not type it).
    return {
      outcome: { outcome: 'selected', optionId: submit.optionId },
      answers: answersOf(outcome.answers),
    } as RequestPermissionResponse;
  }

  /**
   * The plan review `exit_plan_mode` presents: the plan as a plan of its own,
   * then the agent's own verdicts (restore the previous mode, auto-accept
   * edits, approve manually, keep planning) as the approval card. The chosen
   * option id is the whole verdict — the tool reads it from the reply.
   */
  private async answerPlan(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const call = request.toolCall;
    const plan = planTextOf(call);
    if (plan !== undefined) this.deliver({ entryType: 'plan', text: plan, timestamp: now() });
    const options = request.options.map((option) => ({ id: option.optionId, label: option.name }));
    const revise = request.options.find((option) => option.kind === 'reject_once')?.optionId;
    const outcome = await this.ctx.requestPlanApproval(call.toolCallId, options, revise);
    if (outcome.outcome !== 'selected') return { outcome: { outcome: 'cancelled' } };
    if (!request.options.some((option) => option.optionId === outcome.optionId)) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: outcome.optionId } };
  }

  /** A file change the agent is asking about: Qwen Code puts the diff in the
   *  permission request's own content, and the completed call carries text
   *  only, so this is where the phone sees it — before it decides. */
  private showPermissionDiff(request: RequestPermissionRequest): void {
    const content = request.toolCall.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (record(block).type !== 'diff') continue;
      const diff = record(block);
      const path = str(diff.path);
      if (path === '') continue;
      const lines = [...toDiffLines(str(diff.oldText), 'del'), ...toDiffLines(str(diff.newText), 'add')];
      if (lines.length === 0) continue;
      const truncated = lines.length > MAX_DIFF_LINES;
      this.deliver({
        entryType: 'diff',
        path,
        lines: truncated ? lines.slice(0, MAX_DIFF_LINES) : lines,
        ...(truncated ? { truncated: true } : {}),
        callId: request.toolCall.toolCallId,
        timestamp: now(),
      });
    }
  }
}

export interface QwenDriverOptions {
  /** The runtime that owns the Qwen Code processes. */
  runtime: QwenRuntime;
  /** `$QWEN_HOME` — where Qwen Code's settings and transcripts live. */
  home: string;
  /** The environment the host runs with; a session inherits it. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Outbound HTTP to provider profiles' endpoints. */
  providerHttp?: ProviderHttp;
  log: (message: string) => void;
}

export class QwenDriver implements Driver {
  private unavailable: string | undefined;
  /** The provider profiles, oldest first, as `set-providers` handed them. */
  private providers: ProviderBinding[] = [];
  /** Everything the settings file needs in place before a process starts. */
  private prepared: Promise<unknown>;
  /** Why the settings file could not be written, while that is so. A Qwen
   *  Code with no readable settings has no provider to run on, so this is a
   *  session's failure rather than a log line. */
  private settingsError: string | undefined;
  private readonly sessions = new Map<string, AcpSession<undefined, AcpProcessEvents>>();
  private readonly live: AcpSessionRegistry<undefined, AcpProcessEvents> = {
    events: (): AcpProcessEvents => ({
      ended: (sessionIds: readonly string[], error: string) => {
        for (const sessionId of sessionIds) this.sessions.get(sessionId)?.endFromProcess(error);
      },
    }),
    add: (sessionId: string, session: AcpSession<undefined, AcpProcessEvents>): void => {
      this.sessions.set(sessionId, session);
    },
    remove: (sessionId: string): void => {
      this.sessions.delete(sessionId);
    },
  };

  private constructor(private readonly options: QwenDriverOptions) {
    // The settings file has to exist before any process boots: Qwen Code
    // reads its provider list and its auth type as it starts. A failure is
    // kept, not swallowed — a session has to refuse rather than start an
    // agent that will answer `session/new` with `Authentication required`.
    this.prepared = this.writeSettings([]);
  }

  /** Write the settings for `providers`, remembering whether it worked. */
  private async writeSettings(providers: ProviderBinding[]): Promise<void> {
    try {
      await writeQwenSettings(this.options.home, providers, this.options.log);
      this.settingsError = undefined;
    } catch (error) {
      this.settingsError = reason(error);
      this.options.log(`[qwen] could not write ${this.options.home}/settings.json: ${this.settingsError}`);
    }
  }

  static create(options: QwenDriverOptions): QwenDriver {
    const driver = new QwenDriver(options);
    // The runtime is fetched as the host starts, like the other agents', so
    // the first session finds it ready instead of waiting on a download.
    void options.runtime.prepare();
    return driver;
  }

  /** Mark the driver unusable (a path the operator named is not a file). */
  setUnavailable(reason: string): void {
    this.unavailable = reason;
  }

  info(): AgentInfo {
    return {
      id: QWEN_AGENT_ID,
      displayName: QWEN_LABEL,
      modes: QWEN_MODES,
      efforts: QWEN_EFFORTS,
      defaultMode: DEFAULT_MODE,
      // What Qwen Code's ACP surface carries, and what it does not: no
      // subscription usage, no plugin or MCP management (both are its own
      // configuration files). Its provider profiles add their models rather
      // than binding a session, so `providers` is not advertised.
      supports: {
        models: true,
        usage: false,
        providers: false,
        providerModels: true,
        interrupt: true,
        commands: true,
        plugins: false,
        mcp: false,
        tasks: false,
      },
      credentials: [],
      ...(this.unavailable ? { unavailableReason: this.unavailable } : {}),
    };
  }

  startSession(params: StartSession, ctx: SessionContext): DriverSession {
    if (this.unavailable) throw new Error(this.unavailable);
    if (params.mode !== undefined && !QWEN_MODES.some((mode) => mode.id === params.mode)) {
      throw new Error(`${QWEN_LABEL} has no mode '${params.mode}'`);
    }
    if (this.settingsError !== undefined) {
      throw new Error(
        `${QWEN_LABEL}'s settings could not be written (${this.settingsError}) — check that ${this.options.home} is writable.`,
      );
    }
    if (this.providers.length === 0) {
      throw new Error(
        `${QWEN_LABEL} has no AI provider on this machine — add an OpenAI-compatible provider profile for it, then start the session again.`,
      );
    }
    return new QwenSession(params, ctx, {
      runtime: this.options.runtime,
      baseEnv: this.options.baseEnv ?? process.env,
      providers: () => this.providers,
      live: this.live,
      prepared: this.prepared,
      tag: 'qwen',
      label: QWEN_LABEL,
    });
  }

  /**
   * The models the provider profiles offer, as the phone lists them: each
   * profile's models, grouped by the profile's name, with the profile's own
   * model ids (not the `<id>(openai)` value Qwen Code selects them by).
   */
  async listModels(): Promise<{ models: ModelEntry[]; defaultModel?: string }> {
    const seen = new Set<string>();
    const models: ModelEntry[] = [];
    for (const profile of this.providers) {
      for (const model of profile.models) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        models.push({ id: model.id, label: model.label ?? model.id, provider: profile.label });
      }
    }
    const defaultModel = models.some((model) => model.id === firstDefault(this.providers))
      ? firstDefault(this.providers)
      : models[0]?.id;
    return { models, ...(defaultModel ? { defaultModel } : {}) };
  }

  /**
   * The provider profiles, written into Qwen Code's settings as its OpenAI
   * model providers. Nothing is refused: a profile's models are added to the
   * list under the profile's name, and two profiles offering one model id
   * simply offer it twice.
   */
  async setProviders(providers: ProviderBinding[]): Promise<RefusedProvider[]> {
    this.providers = providers;
    await (this.prepared = this.writeSettings(providers));
    if (this.settingsError === undefined) return [];
    // A profile Qwen Code's settings could not name is one it cannot run on:
    // refused with the reason, so the phone says so rather than offering it.
    const why = `${QWEN_LABEL}'s settings could not be written (${this.settingsError})`;
    return providers.map((profile) => ({ id: profile.id, reason: why }));
  }

  /** Qwen Code reaches a profile's endpoint as an OpenAI-compatible one: a
   *  session posts chat completions to it. */
  async checkProvider(provider: ProviderBinding, model: string): Promise<boolean | undefined> {
    return this.options.providerHttp ? checkToken(OPENAI_API, provider, model, this.options.providerHttp.post) : undefined;
  }

  async listProviderModels(baseUrl: string, token: string): Promise<EndpointModel[]> {
    if (!this.options.providerHttp) throw new Error('this host reads no provider endpoints');
    return listModels(OPENAI_API, baseUrl, token, this.options.providerHttp.get);
  }

  /** The conversation's files under `$QWEN_HOME`. `cwd` is not needed: a
   *  conversation id is a UUID, so every project directory is searched. */
  deleteConversation(conversationId: string, cwd: string): Promise<void> {
    void cwd;
    return deleteQwenConversation(this.options.home, conversationId);
  }

  async shutdown(): Promise<void> {
    await this.options.runtime.close();
  }
}

/** The model Qwen Code starts on when a session names none: the first
 *  profile's default, else its first model. */
function firstDefault(providers: ProviderBinding[]): string | undefined {
  for (const profile of providers) {
    if (profile.defaultModel && profile.models.some((model) => model.id === profile.defaultModel)) return profile.defaultModel;
    if (profile.models[0]) return profile.models[0].id;
  }
  return undefined;
}

/** The reasoning levels a session's option state offers. */
function effortChoices(option: SessionConfigOption | undefined): Array<{ value: string; label: string }> {
  return selectChoices(option).filter((choice) => choice.value !== 'default');
}

/** The name of the tool behind one permission ask: Qwen Code keeps it in the
 *  call's `_meta`, with the display title as the fallback. */
function toolNameOf(call: RequestPermissionRequest['toolCall']): string {
  const meta = (call as { _meta?: { toolName?: unknown } | null })._meta;
  if (typeof meta?.toolName === 'string' && meta.toolName !== '') return meta.toolName;
  return call.name ?? call.title ?? 'tool';
}

/** Whether one permission ask is the question form rather than a tool call. */
function isQuestion(request: RequestPermissionRequest): boolean {
  const meta = (request as { _meta?: { qwenInteractionKind?: unknown } | null })._meta;
  if (meta?.qwenInteractionKind === 'user_question') return true;
  // The marker is also carried on the tool call itself.
  const callMeta = (request.toolCall as { _meta?: { qwenInteractionKind?: unknown } | null })._meta;
  return callMeta?.qwenInteractionKind === 'user_question';
}

/** The questions one ask carries, in the wire's shape. */
function questionSpecsOf(request: RequestPermissionRequest): QuestionSpec[] {
  const questions = (record(request.toolCall.rawInput).questions ?? (request.toolCall as { _meta?: { qwenQuestions?: unknown } })._meta?.qwenQuestions);
  if (!Array.isArray(questions)) return [];
  const specs: QuestionSpec[] = [];
  for (const raw of questions) {
    const question = record(raw);
    const text = str(question.question);
    if (text === '') continue;
    const header = str(question.header);
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          const label = str(record(option).label);
          if (label === '') return [];
          const description = str(record(option).description);
          return [{ label, ...(description !== '' ? { description } : {}) }];
        })
      : [];
    specs.push({
      question: text,
      ...(header !== '' ? { header } : {}),
      options,
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return specs;
}

/** The phone's answers as Qwen Code's question tool reads them: one entry per
 *  question, keyed by its position, whose value is the chosen label (or the
 *  labels joined) or what the user typed. */
function answersOf(replies: QuestionReply[]): Record<string, string> {
  const answers: Record<string, string> = {};
  replies.forEach((reply, index) => {
    const value = reply.type === 'selected' ? reply.labels.join(', ') : reply.text.trim();
    if (value !== '') answers[String(index)] = value;
  });
  return answers;
}

/** The plan one `exit_plan_mode` ask carries: the text block in the call's
 *  content, else the call's own `plan` argument. */
function planTextOf(call: RequestPermissionRequest['toolCall']): string | undefined {
  if (Array.isArray(call.content)) {
    for (const block of call.content) {
      const content = record(block);
      if (content.type !== 'content') continue;
      const inner = record(content.content);
      if (inner.type === 'text' && typeof inner.text === 'string' && inner.text !== '') return inner.text;
    }
  }
  const plan = str(record(call.rawInput).plan);
  return plan === '' ? undefined : plan;
}

/** A command's argument hint, which Qwen Code nests under `input`. */
function commandHint(input: unknown): string | undefined {
  const hint = str(record(input).hint);
  return hint === '' ? undefined : hint;
}

function inherited(baseEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
