/**
 * The Claude Code driver, over the Claude Agent SDK (through the facade in
 * facade.ts, the one module that touches the SDK itself).
 *
 * A `ClaudeSession` turns one SDK query into session events: the SDK's
 * `init` becomes `info` (conversation id, resolved model, actual mode) and
 * confirms the session, `session_state_changed` becomes the turn state,
 * `result` refreshes the context-window numbers, and every message is
 * translated into entries by adapter.ts. Its `canUseTool` callback is where
 * Claude Code's modes get their meaning — which calls run unasked, which
 * need the user, and how plan approval switches the mode.
 */
import type { Driver, DriverSession, SessionContext } from '../../driver';
import type { HttpPost } from '../../net';
import { isBenignPlanDirWrite, SECRET_PATH_DENIAL, touchesSecretPath } from '../../policy';
import { PERMISSION_ALLOW, PERMISSION_ALLOW_ALWAYS, PERMISSION_DENY, toolKindOf, toolLocations, toolTitle } from '../../tools';
import { newTranslateContext } from '../../transcript';
import type { AgentInfo, ModelEntry, OptionChoice, OutputEntry, SessionOption, StartSession, UsageData } from '../../types';
import { sdkMessageToEntries } from './adapter';
import { ANTHROPIC_API_KEY_CREDENTIAL, buildClaudeEnv } from './env';
import {
  modelSupports1mContext,
  type SdkAuthStatusMessage,
  type SdkCanUseTool,
  type SdkFacade,
  type SdkMessage,
  type SdkPermissionResult,
  type SdkPermissionUpdate,
  type SdkSessionHandle,
  type SdkSessionOptions,
  type SdkSystemMessage,
} from './facade';
import { HOST_MCP_SERVER, hostToolsServer } from './hostTools';
import { normalizeUsage } from './usage';

export const CLAUDE_CODE_AGENT_ID = 'claude-code';

/** The mode in which every tool call runs without asking. */
export const AUTO_APPROVE_MODE = 'default';
const DEFAULT_MODE = 'plan';

export const CLAUDE_MODES: OptionChoice[] = [
  { id: 'plan', label: 'Plan', description: 'Plan first; nothing runs until you approve the plan' },
  { id: AUTO_APPROVE_MODE, label: 'YOLO', description: 'Run every tool without asking' },
  { id: 'acceptEdits', label: 'Edits', description: 'Accept file edits; ask before other tools' },
];

export const CLAUDE_EFFORTS: OptionChoice[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
  { id: 'max', label: 'Max' },
];

/** Plan approval option ids are the mode the session continues in, except
 *  `revise`, which keeps it planning. */
export const PLAN_REVISE = 'revise';
export const PLAN_APPROVAL_OPTIONS: OptionChoice[] = [
  { id: 'acceptEdits', label: 'Approve, auto-accept edits' },
  { id: AUTO_APPROVE_MODE, label: 'Approve and run without asking' },
  { id: PLAN_REVISE, label: 'Keep planning', description: 'Stay in plan mode and send feedback' },
];

const isMode = (id: string): boolean => CLAUDE_MODES.some((m) => m.id === id);
const isEffort = (id: string): boolean => CLAUDE_EFFORTS.some((e) => e.id === id);

/** A context window no larger than this is the plain tier, not the 1M beta. */
const PLAIN_CONTEXT_WINDOW = 200_000;

/** Tool results are shown on the phone as the card's own outcome, so a
 *  denied call explains itself to the model instead. */
const USER_DENIED = 'User denied';
const KEEP_PLANNING = 'The user wants to keep planning — revise the plan with their feedback.';

/** What one session needs. */
export interface ClaudeDriverOptions {
  facade: SdkFacade;
  /** The `claude` executable, or its on-demand install still in progress
   *  (the session waits for it). Unset: the SDK's own resolution. */
  claudePath?: string | Promise<string>;
}

export interface ClaudeDriverDeps {
  facade: SdkFacade;
  /** An explicit `claude` executable. */
  claudePath?: string;
  /** Installs the binary when there is none (and no `claudePath`). */
  installClaude?: () => Promise<string>;
  /** Outbound HTTP for the API-key check. */
  httpPost?: HttpPost;
}

export class ClaudeSession implements DriverSession {
  private handle: SdkSessionHandle | null = null;
  private readonly translate = newTranslateContext();
  private readonly resumeTarget: string | null;
  private mode: string;
  private model: string | undefined;
  private effort: string | undefined;
  /** Input sent while the Claude Code binary is still being installed. */
  private queuedInput: string[] = [];
  private ready = false;
  private ended = false;
  /** Messages seen on this spawn. >0 proves the subprocess came up and (if a
   *  resume was asked for) the conversation resolved — so a later exit is
   *  some OTHER failure, whatever its stderr tail says. */
  private messages = 0;
  private turn: 'idle' | 'running' = 'idle';
  /** The SDK has sent a `session_state_changed`. Until it does, the turn
   *  state is derived from input sent / `result` received instead; once it
   *  has, its events are the only source, since they also cover background
   *  work that outlives the `result`. */
  private sawStateEvents = false;
  private contextWindow: number | undefined;
  private contextPercentage: number | undefined;
  private loggedContextMismatch = false;
  /** Most recent Task/Agent subagent_type — a best-effort label for a
   *  sub-agent's permission card (the SDK only exposes an opaque agent id). */
  private lastSubagentType: string | undefined;

  constructor(
    private readonly params: StartSession,
    private readonly ctx: SessionContext,
    private readonly options: ClaudeDriverOptions,
  ) {
    this.resumeTarget = params.resume ?? null;
    this.mode = params.mode ?? DEFAULT_MODE;
    this.model = params.model ?? undefined;
    this.effort = params.effort ?? undefined;
  }

  /** Spawn the query. Throws synchronously for an unusable session (a
   *  provider binding that must not be used) — nothing has started then.
   *  While the Claude Code binary is still being installed, the spawn waits
   *  for it; a failed install ends the session with the reason. */
  start(): void {
    const env = buildClaudeEnv(this.params);
    const claudePath = this.options.claudePath;
    if (typeof claudePath === 'object') {
      claudePath.then(
        (resolved) => {
          if (!this.ended) this.spawn(env, resolved);
        },
        (err) => this.finish(err instanceof Error ? err.message : String(err)),
      );
    } else {
      this.spawn(env, claudePath);
    }
  }

  private spawn(env: ReturnType<typeof buildClaudeEnv>, claudePath: string | undefined): void {
    const hostTools = this.params.hostTools ?? [];
    const opts: SdkSessionOptions = {
      sessionId: this.params.sessionId,
      cwd: this.params.cwd,
      permissionMode: this.mode,
      canUseTool: this.canUseTool,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effortLevel: this.effort } : {}),
      // A provider-bound session must never fall back to an Anthropic model,
      // and never answers the machine-wide model list.
      ...(this.params.provider ? { providerId: this.params.provider.id, fallbackModel: null } : {}),
      ...(this.resumeTarget ? { resume: this.resumeTarget } : {}),
      ...(hostTools.length > 0
        ? { mcpServers: { [HOST_MCP_SERVER]: hostToolsServer(hostTools, (tool, args) => this.ctx.callHostTool(tool, args)) } }
        : {}),
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      ...(env ? { env } : {}),
    };
    const handle = this.options.facade.createSession(opts);
    this.handle = handle;
    for (const text of this.queuedInput.splice(0)) handle.pushInput(text);
    if (this.resumeTarget) {
      // A resumed query accepts input right away; its init follows the
      // first turn.
      this.markReady();
    } else {
      // The SDK emits `init` only after the first user message, so a fresh
      // idle session is confirmed by a control-channel round trip instead.
      handle.probeReady().then(
        () => this.markReady(),
        (err) => {
          if (!this.ready) this.finish(`SDK session did not respond: ${err}`);
        },
      );
    }
    this.consume(handle).catch((err) => this.finish(`SDK stream consumer failed: ${err}`));
  }

  private markReady(): void {
    if (this.ready || this.ended) return;
    this.ready = true;
    this.ctx.emit({ type: 'ready' });
  }

  private finish(error?: string, resumeLost = false): void {
    if (this.ended) return;
    this.ended = true;
    void Promise.resolve(this.handle?.end()).catch(() => {});
    this.ctx.emit({ type: 'ended', ...(error ? { error } : {}), ...(resumeLost ? { resumeLost } : {}) });
  }

  private async consume(handle: SdkSessionHandle): Promise<void> {
    try {
      for await (const msg of handle.messages()) {
        if (this.ended) return;
        this.messages++;
        await this.handleMessage(msg);
      }
    } catch (err) {
      if (this.ended) return;
      if (!this.ready) {
        this.finish(`SDK stream error before the session was confirmed: ${err}`);
        return;
      }
      this.finish(String(err), this.isResumeLost(err));
      return;
    }
    if (this.ended) return;
    this.finish(this.ready ? undefined : 'SDK stream closed before the session was confirmed');
  }

  /**
   * Is this stream error the SDK refusing the conversation we asked it to
   * resume? The error text alone cannot say: the SDK's error carries the
   * tail of the CLI's stderr, which hooks, MCP servers and the agent's own
   * shell commands also write to, so "no conversation found" can appear in
   * an error whose real cause is an OOM kill or a network blip. A false
   * positive makes the bridge drop a LIVE conversation for good, so the
   * phrase only counts when the structure agrees: a resume was asked for,
   * the spawn produced no message at all, and the error names that exact id.
   */
  private isResumeLost(err: unknown): boolean {
    const target = this.resumeTarget;
    if (!target || this.messages > 0) return false;
    const text = String(err);
    return /no conversation found/i.test(text) && text.includes(target);
  }

  private async handleMessage(msg: SdkMessage): Promise<void> {
    if (msg.type === 'auth_status') {
      const auth = msg as SdkAuthStatusMessage;
      if (!auth.error) return;
      this.ctx.log(`[claude] auth error for ${this.ctx.sessionId}: ${auth.error}`);
      if (!this.ready) {
        this.finish(`Authentication failed: ${auth.error}`);
        return;
      }
      this.entries([{ entryType: 'notice', kind: 'auth_error', text: `Authentication failed: ${auth.error}`, timestamp: new Date().toISOString() }]);
      return;
    }

    if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
      const init = msg as SdkSystemMessage;
      // Keep the reported mode when it is one of ours; Claude Code's
      // non-prompting modes the catalog does not list (bypassPermissions and
      // friends) are the auto-approve mode.
      const reported = String(init.permissionMode ?? '');
      this.mode = isMode(reported) ? reported : AUTO_APPROVE_MODE;
      // The model the SDK actually RESOLVED — a session started on the
      // default model otherwise reports none at all.
      const modelChanged = typeof init.model === 'string' && init.model !== '' && init.model !== this.model;
      if (modelChanged) this.model = init.model;
      this.ctx.emit({
        type: 'info',
        nativeSessionId: init.session_id,
        mode: this.mode,
        ...(modelChanged ? { model: init.model } : {}),
      });
      this.markReady();
    }

    if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'session_state_changed') {
      this.sawStateEvents = true;
      const state = (msg as unknown as { state: string }).state === 'idle' ? 'idle' : 'running';
      this.setTurn(state);
    } else if (msg.type === 'result' && !this.sawStateEvents && this.turn === 'running') {
      this.setTurn('idle');
    }

    if (msg.type === 'result') this.onResult(msg as { modelUsage?: Record<string, { contextWindow?: number }> });

    const entries = sdkMessageToEntries(msg, this.translate);
    for (const entry of entries) {
      if (entry.entryType === 'tool_call' && (entry.toolName === 'Task' || entry.toolName === 'Agent')) {
        const sub = (entry.rawInput as Record<string, unknown> | undefined)?.subagent_type;
        if (typeof sub === 'string' && sub) this.lastSubagentType = sub;
      }
    }
    this.entries(entries);
  }

  /** The API's own context window for this session (`modelUsage` is keyed
   *  by the resolved model id; sub-agents may run other models, so the main
   *  model wins, else the largest), then the SDK's context-usage meter. */
  private onResult(result: { modelUsage?: Record<string, { contextWindow?: number }> }): void {
    const modelUsage = result.modelUsage;
    if (modelUsage) {
      const cw = (this.model && modelUsage[this.model]?.contextWindow)
        || Math.max(0, ...Object.values(modelUsage).map((u) => u?.contextWindow ?? 0));
      if (cw > 0 && cw !== this.contextWindow) {
        this.contextWindow = cw;
        this.ctx.emit({ type: 'info', contextWindow: cw });
      }
      // The 1M-context beta is requested for every Sonnet/Opus session, but a
      // gateway at ANTHROPIC_BASE_URL can silently drop it; a plain-tier
      // window here is the one place that is provable. Logged once.
      if (!this.loggedContextMismatch && cw > 0 && cw <= PLAIN_CONTEXT_WINDOW && modelSupports1mContext(this.model)) {
        this.loggedContextMismatch = true;
        this.ctx.log(
          `[claude] session ${this.ctx.sessionId} requested the 1M-context beta for model "${this.model}" ` +
            `but the API reported a ${cw}-token window — the beta was likely not honored. If this bridge ` +
            'routes through a gateway or router, verify it forwards the "anthropic-beta: context-1m-2025-08-07" header.',
        );
      }
    }
    void this.refreshContextUsage();
  }

  private async refreshContextUsage(): Promise<void> {
    const usage = await this.handle?.getContextUsage().catch(() => null);
    if (!usage || this.ended) return;
    const pct = typeof usage.percentage === 'number' && isFinite(usage.percentage)
      ? Math.max(0, Math.min(100, Math.round(usage.percentage)))
      : undefined;
    const cw = usage.contextWindow;
    const changedPct = pct !== undefined && pct !== this.contextPercentage;
    const changedCw = cw !== undefined && cw > 0 && cw !== this.contextWindow;
    if (changedPct) this.contextPercentage = pct;
    if (changedCw) this.contextWindow = cw;
    if (changedPct || changedCw) {
      this.ctx.emit({
        type: 'info',
        ...(changedPct ? { contextPercentage: pct } : {}),
        ...(changedCw ? { contextWindow: cw } : {}),
      });
    }
  }

  private setTurn(state: 'idle' | 'running'): void {
    if (this.ended) return;
    this.turn = state;
    this.ctx.emit({ type: 'turn', state });
  }

  private entries(entries: OutputEntry[]): void {
    if (entries.length > 0 && !this.ended) this.ctx.emit({ type: 'entries', entries });
  }

  /**
   * The SDK's permission callback. Order:
   *  1. secret-path hard deny (mode-independent, when the session asks for it)
   *  2. AskUserQuestion → the user's answers
   *  3. EnterPlanMode → allowed; the session is now planning
   *  4. auto-approve mode → allowed
   *  5. a narrow benign write into Claude Code's plan directory → allowed
   *  6. ExitPlanMode → plan approval
   *  7. anything else → the user decides
   */
  private readonly canUseTool: SdkCanUseTool = async (toolName, rawInput, options) => {
    const input = (rawInput ?? {}) as Record<string, unknown>;
    const requestId = options.toolUseID;

    if (this.params.denySecretPaths && touchesSecretPath(toolName, input)) {
      this.ctx.log(`[claude] DENIED secret-path access by test session ${this.ctx.sessionId}: ${toolName}`);
      return { behavior: 'deny', message: SECRET_PATH_DENIAL };
    }

    if (toolName === 'AskUserQuestion') return this.askQuestions(requestId, input);

    if (toolName === 'EnterPlanMode') {
      this.setMode('plan');
      return { behavior: 'allow', updatedInput: {} };
    }

    if (this.mode === AUTO_APPROVE_MODE) return { behavior: 'allow', updatedInput: {} };

    // A plan sub-agent's `mkdir -p ~/.claude/plans` would otherwise block on
    // the phone and can deadlock the whole session.
    if (isBenignPlanDirWrite(toolName, input)) {
      this.ctx.log(`[claude] auto-allowed benign plans-dir write in ${this.ctx.sessionId}: ${toolName}`);
      return { behavior: 'allow', updatedInput: {} };
    }

    if (toolName === 'ExitPlanMode') return this.approvePlan(requestId);

    const locations = toolLocations(input);
    // The SDK's own prompt sentence, when it sent one, describes the call.
    const description = options.description ?? options.title;
    const outcome = await this.ctx.requestPermission({
      requestId,
      toolName,
      kind: toolKindOf(toolName),
      title: toolTitle(toolName, input) || toolName,
      ...(description ? { description } : {}),
      locations,
      rawInput: input,
      options: [PERMISSION_ALLOW, PERMISSION_ALLOW_ALWAYS, PERMISSION_DENY],
      ...(options.agentID ? { subagent: this.lastSubagentType ? { label: this.lastSubagentType } : {} } : {}),
    });
    if (outcome.outcome === 'cancelled') return { behavior: 'deny', message: outcome.reason };
    if (outcome.optionId === PERMISSION_ALLOW.id) return { behavior: 'allow', updatedInput: {} };
    if (outcome.optionId === PERMISSION_ALLOW_ALWAYS.id) {
      // "Always allow" persists as a project allow rule, so it holds across sessions.
      const rule: SdkPermissionUpdate = {
        type: 'addRules',
        rules: [{ toolName }],
        behavior: 'allow',
        destination: 'projectSettings',
      };
      return { behavior: 'allow', updatedInput: {}, updatedPermissions: [rule] };
    }
    return { behavior: 'deny', message: USER_DENIED };
  };

  /**
   * AskUserQuestion answers go back in `updatedInput.answers`, keyed by the
   * FULL question text (the SDK's result builder looks them up that way —
   * keyed by the short header, it crashes), alongside the original input.
   */
  private async askQuestions(requestId: string, input: Record<string, unknown>): Promise<SdkPermissionResult> {
    const questions = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
    const specs = questions.map((q) => ({
      question: typeof q.question === 'string' ? q.question : '',
      ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
      options: (Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : []).map((o) => ({
        label: typeof o.label === 'string' ? o.label : '',
        ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
      })),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    }));
    const outcome = await this.ctx.askQuestion(requestId, specs);
    if (outcome.outcome === 'cancelled') return { behavior: 'deny', message: outcome.reason };
    const answers: Record<string, string> = {};
    specs.forEach((q, i) => {
      answers[q.question] = outcome.answers[i] ?? '';
    });
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  /** Every option but `revise` approves the plan and continues in the mode
   *  it names; `revise` keeps the agent planning (the user's feedback
   *  arrives as the next prompt). */
  private async approvePlan(requestId: string): Promise<SdkPermissionResult> {
    const outcome = await this.ctx.requestPlanApproval(requestId, PLAN_APPROVAL_OPTIONS);
    if (outcome.outcome === 'cancelled') return { behavior: 'deny', message: outcome.reason };
    if (outcome.optionId === PLAN_REVISE || !isMode(outcome.optionId)) return { behavior: 'deny', message: KEEP_PLANNING };
    const mode = outcome.optionId;
    // After the approval resolves: the SDK leaves plan mode on its own
    // answer, then the chosen mode is applied on top.
    queueMicrotask(() => {
      void this.handle?.setPermissionMode(mode).then(
        () => this.setMode(mode),
        (err) => this.ctx.log(`[claude] could not switch ${this.ctx.sessionId} to ${mode}: ${err}`),
      );
    });
    return { behavior: 'allow', updatedInput: {} };
  }

  private setMode(mode: string): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (!this.ended) this.ctx.emit({ type: 'info', mode });
  }

  prompt(text: string): void {
    if (this.ended) return;
    if (this.handle) this.handle.pushInput(text);
    else this.queuedInput.push(text);
    // Turn-state fallback until the SDK sends its own state events: a turn
    // runs from the moment input is handed over until its `result`.
    if (!this.sawStateEvents && this.turn !== 'running') this.setTurn('running');
  }

  async interrupt(): Promise<void> {
    await this.handle?.interrupt();
  }

  /** Before the query is spawned (the binary still installing), a change is
   *  kept and applied at the spawn. */
  async setOption(option: SessionOption, value: string): Promise<void> {
    if (this.ended) throw new Error('the session is not running');
    switch (option) {
      case 'mode':
        if (!isMode(value)) throw new Error(`Claude Code has no mode '${value}'`);
        await this.handle?.setPermissionMode(value);
        this.mode = value;
        return;
      case 'effort':
        if (!isEffort(value)) throw new Error(`Claude Code has no effort level '${value}'`);
        await this.handle?.setEffort(value);
        this.effort = value;
        return;
      case 'model':
        await this.handle?.setModel(value);
        this.model = value;
        return;
    }
  }

  /** The `/usage` snapshot. The SDK method is experimental, so anything
   *  unexpected yields null rather than a guess. */
  async getUsage(): Promise<UsageData | null> {
    if (!this.handle || this.ended) return null;
    try {
      const raw = await this.handle.getUsageSnapshot();
      return raw === null || raw === undefined ? null : normalizeUsage(raw);
    } catch (err) {
      this.ctx.log(`[claude] usage failed for ${this.ctx.sessionId}: ${err}`);
      return null;
    }
  }

  async end(): Promise<void> {
    this.ended = true;
    await this.handle?.end();
  }
}

export class ClaudeDriver implements Driver {
  /** The on-demand install in progress or done; dropped when it fails, so
   *  the next session tries again (a bridge started offline recovers). */
  private install: Promise<string> | null = null;

  constructor(private readonly options: ClaudeDriverDeps) {
    // Start at once, so the binary is usually in place by the first session.
    if (options.installClaude) void this.claudePath();
  }

  private claudePath(): string | Promise<string> | undefined {
    const { claudePath, installClaude } = this.options;
    if (claudePath !== undefined || !installClaude) return claudePath;
    if (!this.install) {
      const attempt = installClaude();
      this.install = attempt;
      attempt.catch(() => {
        if (this.install === attempt) this.install = null;
      });
    }
    return this.install;
  }

  info(): AgentInfo {
    return {
      id: CLAUDE_CODE_AGENT_ID,
      displayName: 'Claude Code',
      modes: CLAUDE_MODES,
      efforts: CLAUDE_EFFORTS,
      defaultMode: DEFAULT_MODE,
      supports: { models: true, usage: true, providers: true, gsd: true, interrupt: true },
      credentials: [{ id: ANTHROPIC_API_KEY_CREDENTIAL, label: 'Anthropic API key', envVar: 'ANTHROPIC_API_KEY' }],
    };
  }

  startSession(params: StartSession, ctx: SessionContext): DriverSession {
    if (params.mode !== undefined && params.mode !== null && !isMode(params.mode)) {
      throw new Error(`Claude Code has no mode '${params.mode}'`);
    }
    if (params.effort !== undefined && params.effort !== null && !isEffort(params.effort)) {
      throw new Error(`Claude Code has no effort level '${params.effort}'`);
    }
    const claudePath = this.claudePath();
    const session = new ClaudeSession(params, ctx, {
      facade: this.options.facade,
      ...(claudePath !== undefined ? { claudePath } : {}),
    });
    session.start();
    return session;
  }

  async listModels(): Promise<{ models: ModelEntry[] }> {
    const models = await this.options.facade.supportedModels();
    return { models: models.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}) })) };
  }

  /** Check an API key with the smallest possible request. A network error
   *  answers undefined rather than reporting the key invalid. */
  async checkCredential(credential: string, value: string): Promise<boolean | undefined> {
    if (credential !== ANTHROPIC_API_KEY_CREDENTIAL || !this.options.httpPost) return undefined;
    try {
      const res = await this.options.httpPost(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': value, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      );
      return res.status !== 401 && res.status !== 403;
    } catch {
      return undefined;
    }
  }
}
