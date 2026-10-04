/**
 * The DeepSeek Harness driver, over the ACP profile of the `dsh` CLI
 * (`dsh --profile acp`, runtime.ts) — the only interface the harness exposes
 * that has everything an interactive client needs: prompts, cancellation,
 * one-shot permission asks, and a model/reasoning selection that can change
 * mid-session. Its `sdk` profile has none of the last three, and `headless`
 * is one-shot.
 *
 * Deliberate limits, all of them the ACP surface's:
 *  - no modes: the harness has none, so `ask`/`default` are this driver's own
 *    (every ask to the phone, or auto-approve);
 *  - no slash commands, questions or background tasks: the automation profile
 *    carries none of them;
 *  - no subscription usage: there is nothing to ask (the context meter
 *    travels as session info instead);
 *  - MCP servers are attached when the harness starts, so a session shows
 *    them but cannot switch one;
 *  - a file change is reconstructed from the call's own arguments: the
 *    harness's result update carries no diff.
 */
import type { RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
import type { Driver, DriverSession, McpManager, PluginManager, SessionContext, SessionMcpState } from '../../driver';
import type { HttpGet } from '../../net';
import { mcpStatus as mcpStatusOf } from '../../mcp';
import { PERMISSION_ALLOW, PERMISSION_DENY, now, toolKindOf, toolLocations, toolTitle } from '../../tools';
import type {
  AgentInfo,
  McpStatus,
  ModelEntry,
  OutputEntry,
  SessionMcpServer,
  SessionOption,
  StartSession,
  UsageData,
} from '../../types';
import { deepseekUpdateToEntries, type ToolCallMemory } from './adapter';
import { DEEPSEEK_API_KEY_CREDENTIAL, DEEPSEEK_API_KEY_ENV, DEEPSEEK_BASE_URL_ENV, buildDeepSeekEnv } from './env';
import { gatewayModelsUrl, syncGatewayCatalog } from './gateway';
import { DSH_LABEL } from './install';
import { DeepSeekMcp } from './mcp';
import { DeepSeekPlugins, runDshPlugin, type DshRun } from './plugins';
import {
  DSH_PROFILE,
  DeepSeekRuntime,
  dshProfileDir,
  type DeepSeekProcess,
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

/** The harness's own option ids (standard ACP session config options). */
const MODEL_CONFIG_ID = 'model';
const EFFORT_CONFIG_ID = 'reasoning_effort';

/** One choice of a session config option. */
interface Choice {
  /** The harness's own selector value (what `set_config_option` takes). */
  value: string;
  label: string;
  /** Who serves it, as a person reads it (`DeepSeek`), when the option says. */
  provider?: string;
  description?: string;
}

/**
 * The choices of a select option. ACP lets an agent send them as one flat
 * list or grouped, and the harness groups its models by provider (one group
 * per configured provider, named after it) while its reasoning levels come
 * flat.
 */
export function selectChoices(option: SessionConfigOption | undefined): Choice[] {
  if (!option || option.type !== 'select') return [];
  const choices: Choice[] = [];
  for (const entry of option.options) {
    if (!isGroup(entry)) {
      choices.push({ value: entry.value, label: entry.name, ...(entry.description ? { description: entry.description } : {}) });
      continue;
    }
    for (const inner of entry.options) {
      choices.push({
        value: inner.value,
        label: inner.name,
        provider: entry.name,
        ...(inner.description ? { description: inner.description } : {}),
      });
    }
  }
  return choices;
}

/** ACP sends a select option's values either as one flat list or as groups;
 *  only a group entry carries values of its own. */
function isGroup(entry: {
  value?: unknown;
  options?: unknown;
}): entry is { name: string; group?: string; options: Array<{ value: string; name: string; description?: string | null }> } {
  return Array.isArray(entry.options);
}

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

export class DeepSeekSession implements DriverSession {
  /** What each tool call's own update carried, for its result and for the
   *  permission card the harness asks about it. */
  private readonly calls: ToolCallMemory = new Map();
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly ready: Promise<void>;
  private mode: string;
  private process?: DeepSeekProcess;
  private nativeId?: string;
  private options: SessionConfigOption[] = [];
  private contextPercentage?: number;
  private contextWindow?: number;
  /** Whether the phone has been told the session is up: until then its model
   *  travels in the identity info, not as a change. */
  private announced = false;
  private ended = false;
  /** Prompts run one at a time: ACP refuses a second prompt while one is in
   *  flight, so a message sent meanwhile waits for the turn before it. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly params: StartSession,
    private readonly ctx: SessionContext,
    private readonly deps: {
      runtime: DeepSeekRuntime;
      mcp: DeepSeekMcp;
      baseEnv: NodeJS.ProcessEnv;
      /** Where this session is registered while it runs, so the driver can
       *  end it when the harness process it shares goes away. */
      live: {
        add(sessionId: string, session: DeepSeekSession): void;
        remove(sessionId: string): void;
        events(): DeepSeekProcessEvents;
      };
      /** The endpoint's catalog, being written into the harness's profile. */
      gateway: Promise<unknown>;
    },
  ) {
    this.cwd = params.cwd;
    this.mode = params.mode ?? DEFAULT_MODE;
    // Built here, not in `init`: a provider profile that cannot be used at
    // all refuses the session before it starts, rather than after an error
    // entry the phone would have to read.
    this.env = buildDeepSeekEnv(params, deps.baseEnv);
    this.ready = this.init();
    // init() reports its own failure as `ended`; nothing else awaits this
    // rejection except prompt/interrupt, which catch it themselves.
    this.ready.catch(() => {});
  }

  private get client() {
    const process_ = this.process;
    if (!process_) throw new Error('the DeepSeek Harness session has not started');
    return process_.client;
  }

  /** The harness process this session shares went away, taking the session
   *  with it. */
  endFromProcess(error: string): void {
    this.finish(error);
  }

  private async init(): Promise<void> {
    try {
      // The harness reads its catalog as it boots, so the endpoint's own
      // models have to be in the profile before a process starts.
      await this.deps.gateway;
      const process_ = await this.deps.runtime.acquire(this.env, this.deps.live.events());
      this.process = process_;
      // A session closed while its harness was starting keeps nothing: the
      // process it acquired is let go at once.
      if (this.ended) {
        this.abandon();
        return;
      }
      const opened = await this.openSession();
      this.nativeId = opened.sessionId;
      this.options = opened.configOptions;
      if (this.ended) {
        this.abandon();
        return;
      }
      process_.attach(opened.sessionId, {
        update: (notification) => this.onUpdate(notification),
        permission: (request) => this.onPermission(request),
      });
      this.deps.live.add(opened.sessionId, this);
      await this.applySelection();
      if (this.ended) return;
      const model = this.currentModel();
      this.announced = true;
      this.ctx.emit({ type: 'info', nativeSessionId: opened.sessionId, ...(model ? { model: model.label } : {}), mode: this.mode });
      this.deliver({ entryType: 'status', text: `${DSH_LABEL} session started${model ? ` (${model.label})` : ''}`, timestamp: now() });
      this.ctx.emit({ type: 'ready' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deliver({ entryType: 'error', text: message, timestamp: now() });
      this.finish(message);
    }
  }

  /** Start a fresh conversation, or continue the one the bridge names. A
   *  conversation the harness no longer has (removed, or started in another
   *  workspace — it checks) falls back to a fresh one with a notice, as the
   *  other drivers do: the transcript is the bridge's, the memory is the
   *  agent's. */
  private async openSession(): Promise<{ sessionId: string; configOptions: SessionConfigOption[] }> {
    const resume = this.params.resume;
    const resumable = this.process?.capabilities.sessionCapabilities?.resume;
    if (resume && resumable !== undefined) {
      try {
        const resumed = await this.client.request('session/resume', { sessionId: resume, cwd: this.cwd, mcpServers: [] });
        return { sessionId: resume, configOptions: resumed.configOptions ?? [] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.ctx.log(`[deepseek] could not resume ${resume} (${reason}) — starting a fresh session`);
        this.deliver({
          entryType: 'notice',
          kind: 'session_restart',
          text:
            `${DSH_LABEL} could not continue this conversation — starting a fresh one in the same workspace. ` +
            'The transcript is preserved, but the model does not remember earlier turns.',
          timestamp: now(),
        });
      }
    }
    const created = await this.client.request('session/new', { cwd: this.cwd, mcpServers: [] });
    return { sessionId: created.sessionId, configOptions: created.configOptions ?? [] };
  }

  /** Apply the model and reasoning level the session was started with. The
   *  model goes first: which reasoning levels exist is the model's own. */
  private async applySelection(): Promise<void> {
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

  private optionOf(id: string): SessionConfigOption | undefined {
    return this.options.find((option) => option.id === id);
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

  /** Change one option and keep the state that comes back — the harness
   *  answers every change with the complete option list. */
  private async setConfig(configId: string, value: string): Promise<void> {
    const sessionId = this.nativeId;
    if (!sessionId) throw new Error('the session has not started');
    const result = await this.client.request('session/set_config_option', { sessionId, configId, value });
    const before = this.currentModel()?.value;
    this.options = result.configOptions ?? this.options;
    const after = this.currentModel();
    if (this.announced && configId === MODEL_CONFIG_ID && after && after.value !== before) {
      this.ctx.emit({ type: 'info', model: after.label });
    }
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
    const entries = deepseekUpdateToEntries(update, this.calls);
    if (entries.length > 0) this.ctx.emit({ type: 'entries', entries });
  }

  /** How full the context is, over the window the harness reports. */
  private reportContext(used: number, size: number): void {
    if (!(size > 0) || !Number.isFinite(used)) return;
    const percentage = Math.max(0, Math.min(100, Math.round((used / size) * 100)));
    if (percentage === this.contextPercentage && size === this.contextWindow) return;
    this.contextPercentage = percentage;
    this.contextWindow = size;
    this.ctx.emit({ type: 'info', contextWindow: size, contextPercentage: percentage });
  }

  /**
   * One permission ask. The harness names only the tool call, so the card
   * comes from that call's own update — which the harness sends before it
   * asks — and the choices are the two it offers: it has no "always allow"
   * to choose.
   */
  private async onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const allow = request.options.find((option) => option.kind === 'allow_once');
    const reject = request.options.find((option) => option.kind === 'reject_once');
    const refuse = (): RequestPermissionResponse =>
      reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
    if (this.ended || !allow) return { outcome: { outcome: 'cancelled' } };
    if (this.mode === AUTO_APPROVE_MODE) return { outcome: { outcome: 'selected', optionId: allow.optionId } };

    const callId = request.toolCall.toolCallId;
    const facts = this.calls.get(callId);
    const toolName = facts?.name ?? request.toolCall.name ?? request.toolCall.title ?? 'tool';
    const input = facts?.input ?? {};
    const locations = toolLocations(input);
    const outcome = await this.ctx.requestPermission({
      requestId: callId,
      toolName,
      kind: toolKindOf(toolName),
      title: toolTitle(toolName, input) || toolName,
      ...(locations.length > 0 ? { locations } : {}),
      rawInput: input,
      options: [PERMISSION_ALLOW, PERMISSION_DENY],
    });
    if (outcome.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } };
    return outcome.optionId === PERMISSION_ALLOW.id ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : refuse();
  }

  private deliver(entry: OutputEntry): void {
    this.ctx.emit({ type: 'entries', entries: [entry] });
  }

  private finish(error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.abandon();
    this.ctx.emit({ type: 'ended', ...(error ? { error } : {}) });
  }

  /** Let go of the harness process this session held. */
  private abandon(): void {
    const process_ = this.process;
    this.process = undefined;
    if (this.nativeId !== undefined) {
      process_?.detach(this.nativeId);
      this.deps.live.remove(this.nativeId);
    }
    process_?.release();
  }

  prompt(text: string): void {
    const next = this.tail.then(
      () => this.runPrompt(text),
      () => this.runPrompt(text),
    );
    this.tail = next.catch(() => {});
  }

  private async runPrompt(text: string): Promise<void> {
    try {
      await this.ready;
      const sessionId = this.nativeId;
      if (this.ended || sessionId === undefined) return;
      this.ctx.emit({ type: 'turn', state: 'running' });
      await this.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      this.endTurn();
    } catch (error) {
      if (this.ended) return;
      this.deliver({ entryType: 'error', text: error instanceof Error ? error.message : String(error), timestamp: now() });
      this.endTurn();
    }
  }

  /** The turn is over: the transcript marks it and the phone stops showing
   *  the agent as working. Every ending is one of these — a cancelled turn
   *  and a failed one end the turn too. */
  private endTurn(): void {
    if (this.ended) return;
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
    }
  }

  async setOption(option: SessionOption, value: string): Promise<void> {
    switch (option) {
      case 'mode':
        if (!DEEPSEEK_MODES.some((mode) => mode.id === value)) throw new Error(`${DSH_LABEL} has no mode '${value}'`);
        this.mode = value;
        return;
      case 'model':
        await this.setConfig(MODEL_CONFIG_ID, this.resolveModel(value) ?? value);
        return;
      case 'effort':
        await this.setConfig(EFFORT_CONFIG_ID, value);
        return;
    }
  }

  async getUsage(): Promise<UsageData | null> {
    // Nothing to ask for: the harness has no subscription usage, and its
    // context meter arrives as session info.
    return null;
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
    const failures = process_?.mcpFailures() ?? new Map<string, string>();
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

  async end(): Promise<void> {
    if (this.ended) return;
    const sessionId = this.nativeId;
    const process_ = this.process;
    this.ended = true;
    if (sessionId !== undefined && process_) {
      // Closing the session lets the harness cancel its work and flush; the
      // conversation stays on disk for a later resume.
      await process_.client.request('session/close', { sessionId }).catch(() => {});
    }
    this.abandon();
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
  /** Spawn seam for the plugin commands, for tests. */
  spawnFn?: SpawnFn;
  log: (message: string) => void;
}

export class DeepSeekDriver implements Driver {
  readonly mcp: DeepSeekMcp;
  readonly plugins: PluginManager;
  private unavailable: string | undefined;
  private models?: Promise<{ models: ModelEntry[]; defaultModel?: string }>;
  /** The gateway's catalog is fetched (and written into the harness profile)
   *  as the host starts, and everything that starts a harness waits for it:
   *  a process reads its catalog once, as it boots. */
  private gateway: Promise<unknown> = Promise.resolve();
  /** Sessions by the harness's own ids: a process serves several, and it is
   *  this map that ends them all when it goes away. */
  private readonly sessions = new Map<string, DeepSeekSession>();
  private readonly live = {
    events: (): DeepSeekProcessEvents => ({
      ended: (sessionIds: readonly string[], error: string) => {
        for (const sessionId of sessionIds) this.sessions.get(sessionId)?.endFromProcess(error);
      },
    }),
    add: (sessionId: string, session: DeepSeekSession): void => {
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
      log: options.log,
    });
  }

  static create(options: DeepSeekDriverOptions): DeepSeekDriver {
    const driver = new DeepSeekDriver(options);
    // The runtime is fetched as the host starts, like the other agents', so
    // the first session (and the model list the phone asks for before it)
    // finds it ready instead of waiting on a download.
    void options.runtime.prepare();
    driver.gateway = driver.syncGateway();
    return driver;
  }

  /**
   * Point the harness at the operator's endpoint, with the models that
   * endpoint serves (gateway.ts): without this a session on a gateway would
   * be sent a DeepSeek model name the gateway does not know, and the phone
   * would offer models that are not there.
   */
  private async syncGateway(): Promise<void> {
    const env = this.options.baseEnv ?? process.env;
    try {
      await syncGatewayCatalog(
        { profileDir: dshProfileDir(this.options.home), log: this.options.log, ...(this.options.httpGet ? { httpGet: this.options.httpGet } : {}) },
        env[DEEPSEEK_BASE_URL_ENV]?.trim() || undefined,
        env[DEEPSEEK_API_KEY_ENV]?.trim() || undefined,
      );
    } catch (error) {
      // The catalog is a convenience, never a reason to refuse to run: the
      // harness's own models still work.
      this.options.log(`[deepseek] could not write the gateway's catalog: ${error instanceof Error ? error.message : String(error)}`);
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
        gsd: true,
        interrupt: true,
        commands: false,
        plugins: true,
        mcp: true,
        tasks: false,
      },
      credentials: [{ id: DEEPSEEK_API_KEY_CREDENTIAL, label: 'DeepSeek API key', envVar: 'DEEPSEEK_API_KEY' }],
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
      gateway: this.gateway,
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
    await this.gateway;
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
   * Check the key against the endpoint it is for: the operator's gateway when
   * one is configured (its `/models` is the one call every gateway has in
   * common — the same one this driver reads the catalog from), else the
   * DeepSeek API. A refusal is a refusal; anything else says nothing.
   */
  async checkCredential(credential: string, value: string): Promise<boolean | undefined> {
    if (credential !== DEEPSEEK_API_KEY_CREDENTIAL || !this.options.httpGet) return undefined;
    const baseEnv = this.options.baseEnv ?? process.env;
    const base = baseEnv[DEEPSEEK_BASE_URL_ENV]?.trim();
    try {
      const res = await this.options.httpGet(base ? gatewayModelsUrl(base) : 'https://api.deepseek.com/models', {
        authorization: `Bearer ${value}`,
      });
      return res.status !== 401 && res.status !== 403;
    } catch {
      return undefined;
    }
  }

  /** One `dsh plugin` invocation, through the same CLI the sessions run. */
  private async runDsh(args: string[]): Promise<DshRun> {
    const entry = await this.options.runtime.entryPoint();
    return this.options.spawnFn === undefined
      ? runDshPlugin(entry, DSH_PROFILE, args)
      : runDshPlugin(entry, DSH_PROFILE, args, this.options.spawnFn);
  }

  async shutdown(): Promise<void> {
    await this.options.runtime.close();
  }
}
