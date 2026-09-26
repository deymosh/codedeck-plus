/**
 * ClaudeSession against a scripted SDK facade: the SDK messages that drive
 * session events (init, state, results, auth errors, stream ends), the
 * resume-lost discriminator, and the canUseTool policy that gives Claude
 * Code's modes their meaning.
 */
import { describe, it, expect } from 'vitest';
import { ClaudeDriver, PLAN_APPROVAL_OPTIONS, unsupportedModelReason } from '../drivers/claude/driver';
import type {
  ModelDiscoveryOptions,
  SdkCanUseTool,
  SdkContextUsage,
  SdkFacade,
  SdkMessage,
  SdkModelDescriptor,
  SdkPermissionResult,
  SdkSessionHandle,
  SdkSessionOptions,
} from '../drivers/claude/facade';
import type { StartSession } from '../types';
import { recordingContext, type Handlers } from './context';

class ScriptedHandle implements SdkSessionHandle {
  readonly pushed: string[] = [];
  readonly modes: string[] = [];
  readonly efforts: string[] = [];
  ended = false;
  private queue: SdkMessage[] = [];
  private wake: (() => void) | null = null;
  private closed: { error?: unknown } | null = null;
  probe: Promise<void> = Promise.resolve();
  contextUsage: SdkContextUsage | null = null;

  push(msg: unknown): void {
    this.queue.push(msg as SdkMessage);
    this.wake?.();
  }

  close(error?: unknown): void {
    this.closed = error === undefined ? {} : { error };
    this.wake?.();
  }

  async *messages(): AsyncIterable<SdkMessage> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) {
        if (this.closed.error !== undefined) throw this.closed.error;
        return;
      }
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  pushInput(text: string): void {
    this.pushed.push(text);
  }
  async setPermissionMode(mode: string): Promise<void> {
    this.modes.push(mode);
  }
  async setModel(): Promise<void> {}
  async setEffort(level: string): Promise<void> {
    this.efforts.push(level);
  }
  async interrupt(): Promise<void> {}
  probeReady(): Promise<void> {
    return this.probe;
  }
  async getContextUsage(): Promise<SdkContextUsage | null> {
    return this.contextUsage;
  }
  async getUsageSnapshot(): Promise<unknown | null> {
    return null;
  }
  async end(): Promise<void> {
    this.ended = true;
    this.close();
  }
}

class ScriptedFacade implements SdkFacade {
  readonly sessions: Array<{ opts: SdkSessionOptions; handle: ScriptedHandle }> = [];
  readonly discoveries: Array<ModelDiscoveryOptions | undefined> = [];
  nextProbe: Promise<void> = Promise.resolve();

  createSession(opts: SdkSessionOptions): SdkSessionHandle {
    const handle = new ScriptedHandle();
    handle.probe = this.nextProbe;
    this.sessions.push({ opts, handle });
    return handle;
  }

  async supportedModels(discovery?: ModelDiscoveryOptions): Promise<SdkModelDescriptor[]> {
    this.discoveries.push(discovery);
    return [{ id: 'claude-sonnet-5', label: 'Sonnet 5' }];
  }

  get last(): { opts: SdkSessionOptions; handle: ScriptedHandle } {
    return this.sessions[this.sessions.length - 1]!;
  }
}

function start(overrides: Partial<StartSession> = {}, handlers: Handlers = {}, facade = new ScriptedFacade()) {
  const ctx = recordingContext(handlers);
  const session = new ClaudeDriver({ facade }).startSession({ sessionId: 's1', agent: 'claude-code', cwd: '/w', ...overrides }, ctx);
  return { ctx, session, facade, handle: facade.last.handle, canUseTool: facade.last.opts.canUseTool as SdkCanUseTool };
}

const init = (over: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'init', session_id: 'native-1', model: 'claude-sonnet-5', permissionMode: 'plan',
  claude_code_version: '2.1.220', ...over,
});

const ask = (canUseTool: SdkCanUseTool, tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  canUseTool(tool, input, { signal: new AbortController().signal, toolUseID: 'toolu_1', ...extra } as Parameters<SdkCanUseTool>[2]) as Promise<SdkPermissionResult>;

describe('Claude session lifecycle', () => {
  it('a fresh session is confirmed by the control-channel probe', async () => {
    const { ctx } = start();
    await ctx.waitFor((e) => e.type === 'ready');
  });

  it('a probe that fails before confirmation ends the session with the reason', async () => {
    const facade = new ScriptedFacade();
    facade.nextProbe = Promise.reject(new Error('spawn ENOENT'));
    const { ctx } = start({}, {}, facade);
    expect((await ctx.ended()).error).toMatch(/did not respond.*spawn ENOENT/);
  });

  it('init reports the conversation id, the resolved model and the actual mode', async () => {
    const { ctx, handle } = start();
    handle.push(init());
    await ctx.waitFor((e) => e.type === 'info' && e.nativeSessionId === 'native-1');
    expect(ctx.events).toContainEqual({ type: 'info', nativeSessionId: 'native-1', mode: 'plan', model: 'claude-sonnet-5' });
    // …and the adapter's status line.
    expect(ctx.entries()).toContainEqual(expect.objectContaining({ entryType: 'status' }));
  });

  it('a non-prompting mode the catalog does not list is the auto-approve mode', async () => {
    const { ctx, handle } = start();
    handle.push(init({ permissionMode: 'bypassPermissions' }));
    await ctx.waitFor((e) => e.type === 'info' && e.mode === 'default');
  });

  it('a clean stream end ends the session normally; before confirmation it is a failure', async () => {
    const ok = start();
    await ok.ctx.waitFor((e) => e.type === 'ready');
    ok.handle.close();
    expect(await ok.ctx.ended()).toEqual({ type: 'ended' });

    const facade = new ScriptedFacade();
    facade.nextProbe = new Promise(() => {});
    const early = start({}, {}, facade);
    early.handle.close();
    expect((await early.ctx.ended()).error).toMatch(/closed before the session was confirmed/);
  });

  it('an auth error fails an unconfirmed session, and is a notice on a running one', async () => {
    const facade = new ScriptedFacade();
    facade.nextProbe = new Promise(() => {});
    const pending = start({}, {}, facade);
    pending.handle.push({ type: 'auth_status', error: 'invalid x-api-key' });
    expect((await pending.ctx.ended()).error).toBe('Authentication failed: invalid x-api-key');

    const running = start();
    await running.ctx.waitFor((e) => e.type === 'ready');
    running.handle.push({ type: 'auth_status', error: 'expired' });
    await running.ctx.waitFor((e) => e.type === 'entries');
    expect(running.ctx.entries()).toContainEqual(expect.objectContaining({ entryType: 'notice', kind: 'auth_error' }));
  });
});

describe('Claude resume', () => {
  const lost = (id: string) => new Error(`Claude Code process exited with code 1. stderr: No conversation found with session ID: ${id}`);

  it('a resumed session is ready at once and resumes the given conversation', async () => {
    const { ctx, facade } = start({ resume: 'native-9' });
    await ctx.waitFor((e) => e.type === 'ready');
    expect(facade.last.opts.resume).toBe('native-9');
  });

  it('the SDK refusing the exact conversation before any output is resume-lost', async () => {
    const { ctx, handle } = start({ resume: 'native-9' });
    handle.close(lost('native-9'));
    expect(await ctx.ended()).toMatchObject({ type: 'ended', resumeLost: true });
  });

  it('the same phrase after output, or naming another id, is some other failure', async () => {
    const after = start({ resume: 'native-9' });
    after.handle.push(init({ session_id: 'native-9' }));
    after.handle.close(lost('native-9'));
    expect((await after.ctx.ended()).resumeLost).toBeUndefined();

    const other = start({ resume: 'native-9' });
    other.handle.close(lost('native-OLD'));
    expect((await other.ctx.ended()).resumeLost).toBeUndefined();
  });
});

describe('Claude turn state and context', () => {
  it('without state events a turn runs from the prompt to its result', async () => {
    const { ctx, session, handle } = start();
    session.prompt('hi');
    expect(handle.pushed).toEqual(['hi']);
    handle.push({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.01, duration_ms: 5 });
    await ctx.waitFor((e) => e.type === 'turn' && e.state === 'idle');
    expect(ctx.events.filter((e) => e.type === 'turn').map((e) => e.type === 'turn' && e.state)).toEqual(['running', 'idle']);
  });

  it('once the SDK sends state events, they alone drive the turn', async () => {
    const { ctx, session, handle } = start();
    handle.push({ type: 'system', subtype: 'session_state_changed', state: 'running' });
    await ctx.waitFor((e) => e.type === 'turn');
    session.prompt('again');
    handle.push({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, duration_ms: 1 });
    handle.push({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    await ctx.waitFor((e) => e.type === 'turn' && e.state === 'idle');
    expect(ctx.events.filter((e) => e.type === 'turn').map((e) => e.type === 'turn' && e.state)).toEqual(['running', 'idle']);
  });

  it('a result reports the real context window and the context meter', async () => {
    const { ctx, handle } = start();
    handle.contextUsage = { percentage: 37.4 };
    handle.push(init());
    handle.push({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, duration_ms: 1, modelUsage: { 'claude-sonnet-5': { contextWindow: 1_000_000 } } });
    await ctx.waitFor((e) => e.type === 'info' && e.contextPercentage === 37);
    expect(ctx.events).toContainEqual({ type: 'info', contextWindow: 1_000_000 });
  });
});

describe('Claude permission policy', () => {
  it('the auto-approve mode allows without asking', async () => {
    const { ctx, canUseTool } = start({ mode: 'default' });
    expect(await ask(canUseTool, 'Bash', { command: 'rm -rf build' })).toMatchObject({ behavior: 'allow' });
    expect(ctx.permissions).toEqual([]);
  });

  it('otherwise the user decides, on a card describing the call', async () => {
    const { ctx, canUseTool } = start({ mode: 'acceptEdits' }, { permission: () => ({ outcome: 'selected', optionId: 'allow' }) });
    expect(await ask(canUseTool, 'Bash', { command: 'npm test' }, { title: 'Claude wants to run npm test' })).toMatchObject({ behavior: 'allow' });
    expect(ctx.permissions).toEqual([{
      requestId: 'toolu_1',
      toolName: 'Bash',
      kind: 'execute',
      title: 'npm test',
      description: 'Claude wants to run npm test',
      locations: [],
      rawInput: { command: 'npm test' },
      options: [
        { id: 'allow', label: 'Allow', kind: 'allow_once' },
        { id: 'allow_always', label: 'Always allow', kind: 'allow_always' },
        { id: 'deny', label: 'Deny', kind: 'reject_once' },
      ],
    }]);
  });

  it('"always allow" persists a project rule; deny and cancel explain themselves', async () => {
    const always = start({ mode: 'acceptEdits' }, { permission: () => ({ outcome: 'selected', optionId: 'allow_always' }) });
    expect(await ask(always.canUseTool, 'Bash', { command: 'ls' })).toEqual({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'projectSettings' }],
    });
    const denied = start({ mode: 'acceptEdits' });
    expect(await ask(denied.canUseTool, 'Bash', { command: 'ls' })).toEqual({ behavior: 'deny', message: 'User denied' });
    const cancelled = start({ mode: 'acceptEdits' }, { permission: () => ({ outcome: 'cancelled', reason: 'Timed out' }) });
    expect(await ask(cancelled.canUseTool, 'Bash', { command: 'ls' })).toEqual({ behavior: 'deny', message: 'Timed out' });
  });

  it('a sub-agent card carries the last sub-agent type as its label', async () => {
    const { ctx, handle, canUseTool } = start({ mode: 'acceptEdits' });
    handle.push({
      type: 'assistant', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'look', subagent_type: 'Explore' } }] },
    });
    await ctx.waitFor((e) => e.type === 'entries');
    await ask(canUseTool, 'Read', { file_path: '/w/a.rs' }, { agentID: 'agent-7' });
    expect(ctx.permissions[0]?.subagent).toEqual({ label: 'Explore' });
  });

  it('a test session refuses secret paths even in the auto-approve mode', async () => {
    const { ctx, canUseTool } = start({ mode: 'default', denySecretPaths: true });
    const result = await ask(canUseTool, 'Read', { file_path: '/w/release.keystore' });
    expect(result).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/hard security boundary/) });
    expect(ctx.permissions).toEqual([]);
  });

  it('EnterPlanMode is allowed and switches the session to planning', async () => {
    const { ctx, canUseTool } = start({ mode: 'default' });
    expect(await ask(canUseTool, 'EnterPlanMode', {})).toMatchObject({ behavior: 'allow' });
    expect(ctx.events).toContainEqual({ type: 'info', mode: 'plan' });
    // Planning now: a write outside the plans dir needs the user.
    await ask(canUseTool, 'Write', { file_path: '/w/a.rs', content: 'x' });
    expect(ctx.permissions).toHaveLength(1);
  });

  it('questions are answered by question text, alongside the original input', async () => {
    const input = { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }, { question: 'Why?', options: [] }] };
    const { ctx, canUseTool } = start({ mode: 'default' }, { question: () => ({ outcome: 'answered', answers: ['Blue', 'because'] }) });
    expect(await ask(canUseTool, 'AskUserQuestion', input)).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which color?': 'Blue', 'Why?': 'because' } },
    });
    expect(ctx.questions[0]).toEqual({
      requestId: 'toolu_1',
      questions: [
        { question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] },
        { question: 'Why?', options: [] },
      ],
    });
  });

  it('plan approval: an approving option continues in that mode, revise keeps planning', async () => {
    const approve = start({ mode: 'plan' }, { plan: () => ({ outcome: 'selected', optionId: 'acceptEdits' }) });
    expect(await ask(approve.canUseTool, 'ExitPlanMode', { plan: '1. x' })).toMatchObject({ behavior: 'allow' });
    expect(approve.ctx.plans[0]?.options).toEqual(PLAN_APPROVAL_OPTIONS);
    await approve.ctx.waitFor((e) => e.type === 'info' && e.mode === 'acceptEdits');
    expect(approve.handle.modes).toEqual(['acceptEdits']);

    const revise = start({ mode: 'plan' }, { plan: () => ({ outcome: 'selected', optionId: 'revise' }) });
    expect(await ask(revise.canUseTool, 'ExitPlanMode', { plan: '1. x' })).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/keep planning/) });
    expect(revise.handle.modes).toEqual([]);
  });
});

describe('Claude options and setup', () => {
  it('validates modes and effort levels against its catalog', async () => {
    const { session, handle } = start();
    await session.setOption('mode', 'acceptEdits');
    await session.setOption('effort', 'max');
    await expect(session.setOption('mode', 'ask')).rejects.toThrow(/no mode/);
    await expect(session.setOption('effort', 'extreme')).rejects.toThrow(/no effort/);
    expect(handle.modes).toEqual(['acceptEdits']);
    expect(handle.efforts).toEqual(['max']);
    expect(() => start({ mode: 'ask' })).toThrow(/no mode/);
  });

  it('a provider binding that must not be used refuses the session before anything starts', () => {
    const facade = new ScriptedFacade();
    expect(() => start({ provider: { id: 'p', baseUrl: 'http://remote.example', authToken: 't', models: [] } }, {}, facade)).toThrow(/insecure base URL/);
    expect(facade.sessions).toHaveLength(0);
  });

  it('a provider-bound session never falls back to an Anthropic model', () => {
    const { facade } = start({ provider: { id: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', authToken: 't', models: [{ id: 'kimi-k3' }] } });
    expect(facade.last.opts).toMatchObject({ providerId: 'kimi', fallbackModel: null });
    expect(facade.last.opts.env?.ANTHROPIC_AUTH_TOKEN).toBe('t');
  });

  it('host tools become an MCP server whose calls go back to the bridge', () => {
    const { facade } = start({ hostTools: [{ name: 'list', description: 'List devices', inputSchema: { type: 'object', properties: {} } }] });
    expect(Object.keys(facade.last.opts.mcpServers ?? {})).toEqual(['codedeck']);
  });

  it('checks an API key with one request, answering undefined when it cannot', async () => {
    const statuses = [200, 401, 403, 529];
    const results: Array<boolean | undefined> = [];
    for (const status of statuses) {
      const driver = new ClaudeDriver({ facade: new ScriptedFacade(), httpPost: async () => ({ status }) });
      results.push(await driver.checkCredential('anthropic_api_key', 'sk'));
    }
    expect(results).toEqual([true, false, false, true]);
    const offline = new ClaudeDriver({ facade: new ScriptedFacade(), httpPost: async () => { throw new Error('ENOTFOUND'); } });
    expect(await offline.checkCredential('anthropic_api_key', 'sk')).toBeUndefined();
    expect(await offline.checkCredential('other', 'x')).toBeUndefined();
  });
});

describe('Claude Code installed on demand', () => {
  const params = { sessionId: 's1', agent: 'claude-code', cwd: '/w' };

  it('a session waits for the install, keeping the input and options sent meanwhile', async () => {
    const facade = new ScriptedFacade();
    let finish!: (path: string) => void;
    const driver = new ClaudeDriver({ facade, installClaude: () => new Promise<string>((r) => (finish = r)) });
    const ctx = recordingContext();
    const session = driver.startSession(params, ctx);
    session.prompt('hello');
    await session.setOption('effort', 'high');
    expect(facade.sessions).toHaveLength(0);

    finish('/cache/claude');
    await ctx.waitFor((e) => e.type === 'ready');
    expect(facade.last.opts.pathToClaudeCodeExecutable).toBe('/cache/claude');
    expect(facade.last.opts.effortLevel).toBe('high');
    expect(facade.last.handle.pushed).toEqual(['hello']);
  });

  it('a failed install ends the session with the reason, and the next session retries', async () => {
    const facade = new ScriptedFacade();
    const attempts: string[] = [];
    const driver = new ClaudeDriver({
      facade,
      installClaude: async () => {
        attempts.push('try');
        if (attempts.length === 1) throw new Error('Claude Code could not be installed: HTTP 503');
        return '/cache/claude';
      },
    });
    const first = recordingContext();
    driver.startSession(params, first);
    expect((await first.ended()).error).toMatch(/could not be installed: HTTP 503/);
    expect(driver.info().unavailableReason).toBeUndefined();

    const second = recordingContext();
    driver.startSession({ ...params, sessionId: 's2' }, second);
    await second.waitFor((e) => e.type === 'ready');
    expect(attempts).toHaveLength(2);
    expect(facade.last.opts.pathToClaudeCodeExecutable).toBe('/cache/claude');
  });

  it('an explicit path is used as is, with no install', async () => {
    const facade = new ScriptedFacade();
    let installs = 0;
    const driver = new ClaudeDriver({ facade, claudePath: '/usr/bin/claude', installClaude: async () => `${++installs}` });
    const ctx = recordingContext();
    driver.startSession(params, ctx);
    await ctx.waitFor((e) => e.type === 'ready');
    expect(facade.last.opts.pathToClaudeCodeExecutable).toBe('/usr/bin/claude');
    expect(installs).toBe(0);
  });
});

describe('Claude model discovery', () => {
  it('lists models at start, through a discovery session on the installed binary', async () => {
    const facade = new ScriptedFacade();
    let finishInstall: (path: string) => void = () => {};
    const driver = new ClaudeDriver({
      facade,
      discoverModels: true,
      installClaude: () => new Promise((resolve) => (finishInstall = resolve)),
    });
    // The start-up listing waits for the binary it needs.
    await Promise.resolve();
    expect(facade.discoveries).toEqual([]);
    finishInstall('/cache/claude');
    await expect.poll(() => facade.discoveries).toEqual([{ pathToClaudeCodeExecutable: '/cache/claude' }]);
    expect((await driver.listModels()).models).toEqual([{ id: 'claude-sonnet-5', label: 'Sonnet 5' }]);
  });

  it('reports Opus 5.5 as the default model, and runs a session with no model on it', async () => {
    expect(new ClaudeDriver({ facade: new ScriptedFacade() }).info()).toMatchObject({ defaultMode: 'plan', defaultEffort: 'medium' });
    expect((await new ClaudeDriver({ facade: new ScriptedFacade() }).listModels()).defaultModel).toBe('claude-opus-5-5');
    const { ctx, facade } = start();
    await ctx.waitFor((e) => e.type === 'ready');
    expect(facade.last.opts.model).toBe('claude-opus-5-5');
    expect(ctx.events.slice(0, 2)).toEqual([{ type: 'info', model: 'claude-opus-5-5' }, { type: 'ready' }]);
  });

  it('a chosen model, or a provider binding, is not overridden by the default', async () => {
    const chosen = start({ model: 'claude-sonnet-5' });
    await chosen.ctx.waitFor((e) => e.type === 'ready');
    expect(chosen.facade.last.opts.model).toBe('claude-sonnet-5');
    expect(chosen.ctx.events.some((e) => e.type === 'info')).toBe(false);

    const bound = start({ provider: { id: 'p', baseUrl: 'https://x', authToken: 't', models: [] } });
    await bound.ctx.waitFor((e) => e.type === 'ready');
    expect(bound.facade.last.opts.model).toBeUndefined();
  });

  it('without discovery, only live sessions are asked', async () => {
    const facade = new ScriptedFacade();
    await new ClaudeDriver({ facade }).listModels();
    expect(facade.discoveries).toEqual([undefined]);
  });
});

describe('Claude model checks', () => {
  const known = [
    { id: 'default', label: 'Default', resolvedModel: 'claude-opus-5-5' },
    { id: 'sonnet[1m]', label: 'Sonnet (1M)', resolvedModel: 'claude-sonnet-5' },
    { id: 'Golem/local-model', label: 'local-model' },
  ];

  it('accepts listed ids, resolved ids, gateway model parts and plain claude ids', () => {
    for (const model of ['sonnet[1m]', 'claude-sonnet-5', 'claude-opus-5-5[1m]', 'local-model', 'Golem/local-model', 'claude-haiku-4-5']) {
      expect(unsupportedModelReason(model, known)).toBeUndefined();
    }
  });

  it("refuses another agent's model, and lets anything through while no list is known", () => {
    expect(unsupportedModelReason('opencode/nemotron-3.5-lightning-free', known)).toMatch(/does not offer the model 'opencode\/nemotron/);
    expect(unsupportedModelReason('opencode/nemotron-3.5-lightning-free', [])).toBeUndefined();
  });

  it('holds a provider-bound session to its profile', () => {
    const provider = { id: 'kimi', baseUrl: 'https://x', authToken: 't', models: [{ id: 'kimi-k3' }] };
    expect(unsupportedModelReason('kimi-k3', [], provider)).toBeUndefined();
    expect(unsupportedModelReason('claude-opus-5-5', known, provider)).toMatch(/profile 'kimi' does not offer/);
  });

  it('refuses a new session, and a switch, to a model the list does not offer', async () => {
    const facade = new ScriptedFacade();
    const driver = new ClaudeDriver({ facade });
    await driver.listModels();
    const params = { sessionId: 's1', agent: 'claude-code', cwd: '/w' };
    expect(() => driver.startSession({ ...params, model: 'opencode/big-pickle' }, recordingContext())).toThrow(/does not offer/);
    // A resumed conversation is not second-guessed.
    expect(() => driver.startSession({ ...params, model: 'opencode/big-pickle', resume: 'n1' }, recordingContext())).not.toThrow();

    const ctx = recordingContext();
    const session = driver.startSession(params, ctx);
    await ctx.waitFor((e) => e.type === 'ready');
    await expect(session.setOption('model', 'opencode/big-pickle')).rejects.toThrow(/does not offer/);
    await session.setOption('model', 'claude-sonnet-5');
  });
});
