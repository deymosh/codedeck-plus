import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CANCEL_GRACE_MS, SESSION_REQUEST_TIMEOUT_MS } from '../../../acp/session';
import { FakeAgent } from '../../../acp/__tests__/fakeAgent';
import { recordingContext, type RecordingContext } from '../../../sdk/__tests__/context';
import type { DriverSession } from '../../../sdk/driver';
import type { ProviderBinding, StartSession } from '../../../sdk/types';
import { QwenDriver } from '../driver';
import { qwenKeyEnvName } from '../settings';
import { QwenRuntime } from '../runtime';

/** The option state a Qwen Code session starts with: its modes, its model and
 *  its reasoning levels, exactly as `session/new` composes them. */
function configOptions(): unknown[] {
  return [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'auto',
      options: [
        { value: 'plan', name: 'Plan' },
        { value: 'default', name: 'Default' },
        { value: 'auto-edit', name: 'Auto Edit' },
        { value: 'auto', name: 'Auto' },
        { value: 'yolo', name: 'YOLO' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'glm-5.3(openai)',
      options: [{ value: 'glm-5.3(openai)', name: 'GLM 5.3' }],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'none', name: 'Thinking off' },
        { value: 'default', name: 'Default' },
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
  ];
}

const modeState = () => ({
  currentModeId: 'auto',
  availableModes: [
    { id: 'plan', name: 'Plan' },
    { id: 'default', name: 'Default' },
    { id: 'auto-edit', name: 'Auto Edit' },
    { id: 'auto', name: 'Auto' },
    { id: 'yolo', name: 'YOLO' },
  ],
});

const PROFILE: ProviderBinding = {
  id: 'p1',
  label: 'Gateway',
  baseUrl: 'https://gateway.example',
  authToken: 'sk-secret',
  models: [{ id: 'glm-5.3', label: 'GLM 5.3' }],
  defaultModel: 'glm-5.3',
};

interface Harness {
  driver: QwenDriver;
  runtime: QwenRuntime;
  agent: FakeAgent;
  home: string;
  spawns: Array<{ command: string; args: string[]; env: Record<string, string> }>;
  session: DriverSession;
}

function withDriver(options: { env?: NodeJS.ProcessEnv; qwenPath?: string; providers?: ProviderBinding[] } = {}): Harness {
  const home = mkdtempSync(path.join(tmpdir(), 'codedeck-qwen-'));
  const agent = new FakeAgent();
  agent.options = configOptions();
  agent.modes = modeState();
  const spawns: Harness['spawns'] = [];
  const runtime = new QwenRuntime({
    ...(options.qwenPath !== undefined ? { qwenPath: options.qwenPath } : {}),
    home,
    cacheDir: path.join(home, 'agents'),
    installQwen: async () => '/fake/qwen/cli-entry.js',
    spawnFn: ((command: string, args: string[], opts: { env: Record<string, string> }) => {
      spawns.push({ command, args, env: opts.env });
      return agent.child;
    }) as never,
    idleCloseMs: 0,
    log: () => {},
  });
  const driver = QwenDriver.create({
    runtime,
    home,
    baseEnv: options.env ?? ({} as NodeJS.ProcessEnv),
    log: () => {},
  });
  void driver.setProviders(options.providers ?? [PROFILE]);
  return { driver, runtime, agent, home, spawns, session: undefined as never };
}

function start(overrides: Partial<StartSession> = {}): StartSession {
  return { sessionId: 'b1', agent: 'qwen-code', cwd: '/work', ...overrides };
}

async function started(
  ready: Harness,
  overrides: Partial<StartSession> = {},
  ctx: RecordingContext = recordingContext(),
): Promise<RecordingContext> {
  ready.session = ready.driver.startSession(start(overrides), ctx);
  await ctx.waitFor((event) => event.type === 'ready');
  return ctx;
}

const infoEvents = (ctx: RecordingContext) => ctx.events.filter((event) => event.type === 'info');

describe('QwenDriver.info', () => {
  it('advertises what the ACP surface carries, and what it does not', () => {
    const { driver } = withDriver();
    const info = driver.info();
    expect(info.id).toBe('qwen-code');
    expect(info.displayName).toBe('Qwen Code');
    expect(info.modes?.map((mode) => mode.id)).toEqual(['default', 'auto-edit', 'plan', 'auto', 'yolo']);
    expect(info.defaultMode).toBe('default');
    expect(info.efforts?.map((effort) => effort.id)).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(info.supports).toEqual({
      models: true,
      usage: false,
      providers: false,
      providerModels: true,
      interrupt: true,
      commands: true,
      plugins: false,
      mcp: false,
      tasks: false,
    });
    expect(info.credentials).toEqual([]);
  });
});

describe('QwenDriver models', () => {
  it('lists the profiles’ models, grouped by the profile’s name', async () => {
    const { driver } = withDriver();
    expect(await driver.listModels()).toEqual({
      models: [{ id: 'glm-5.3', label: 'GLM 5.3', provider: 'Gateway' }],
      defaultModel: 'glm-5.3',
    });
  });

  it('writes the profiles into Qwen Code’s own settings, without the token', async () => {
    const { driver, home } = withDriver();
    await driver.setProviders([PROFILE]);
    const settings = JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(settings.security).toEqual({ auth: { selectedType: 'openai' } });
    expect(settings.model).toEqual({ name: 'glm-5.3' });
    expect(settings.general).toEqual({ enableAutoUpdate: false });
    expect((settings.modelProviders as { openai: unknown[] }).openai).toEqual([
      { id: 'glm-5.3', name: 'GLM 5.3', envKey: qwenKeyEnvName('p1', 'https://gateway.example/v1'), baseUrl: 'https://gateway.example/v1' },
    ]);
    // The token is nowhere in the file: it travels in the process environment.
    expect(readFileSync(path.join(home, 'settings.json'), 'utf8')).not.toContain('sk-secret');
  });

  it('keeps the settings whole when profiles arrive faster than they are written', async () => {
    const { driver, home } = withDriver();
    const other = { ...PROFILE, id: 'p2', models: [{ id: 'qwen3-coder', label: 'Qwen3 Coder' }], defaultModel: 'qwen3-coder' };
    await Promise.all([driver.setProviders([PROFILE, other]), driver.setProviders([]), driver.setProviders([other])]);
    // Valid JSON, holding the last profiles handed over.
    const settings = JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect((settings.modelProviders as { openai: Array<{ id: string }> }).openai.map((entry) => entry.id)).toEqual(['qwen3-coder']);
  });

  it('refuses a session on a machine with no provider profile', () => {
    const { driver } = withDriver();
    void driver.setProviders([]);
    expect(() => driver.startSession(start(), recordingContext())).toThrow(/no AI provider/);
  });

  it('refuses a profile, and a session, when its settings cannot be written', async () => {
    // A home under a file: every write into it fails, as a read-only volume's
    // would. Qwen Code with no settings has no provider, so this is a refusal
    // rather than a log line.
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'codedeck-qwen-bad-')), 'file');
    writeFileSync(file, 'not a directory');
    const runtime = new QwenRuntime({
      home: file,
      cacheDir: file,
      installQwen: async () => '/fake/qwen/cli-entry.js',
      idleCloseMs: 0,
      log: () => {},
    });
    const driver = QwenDriver.create({ runtime, home: path.join(file, 'qwen'), baseEnv: {}, log: () => {} });
    expect(await driver.setProviders([PROFILE])).toEqual([{ id: 'p1', reason: expect.stringContaining("settings could not be written") }]);
    expect(() => driver.startSession(start(), recordingContext())).toThrow(/settings could not be written/);
  });
});

describe('QwenSession startup', () => {
  it('starts a session, switches it off Qwen Code’s own default mode and reports its identity', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    expect(ready.agent.newSessions).toEqual([{ cwd: '/work', mcpServers: [] }]);
    // session/new starts in `auto`; the session asked for none, so it is
    // switched to the catalog default before it accepts a prompt.
    expect(ready.agent.setModes).toEqual([{ sessionId: 's1', modeId: 'default' }]);
    expect(infoEvents(ctx)[0]).toEqual({ type: 'info', nativeSessionId: 's1', model: 'GLM 5.3', mode: 'default' });
  });

  it('ends the session when session/new never answers, instead of waiting for ever', async () => {
    const ready = withDriver();
    // The settings write is real I/O; let it finish before time is faked,
    // so the only timer is the request's own deadline.
    await ready.driver.setProviders([PROFILE]);
    ready.agent.ignoreNewSession = true;
    vi.useFakeTimers();
    try {
      const ctx = recordingContext();
      ready.driver.startSession(start(), ctx);
      await vi.advanceTimersByTimeAsync(SESSION_REQUEST_TIMEOUT_MS);
      expect(ctx.events.find((event) => event.type === 'ended')).toMatchObject({
        type: 'ended',
        error: expect.stringMatching(/session\/new did not answer within 15000ms/),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the session an agent creates after the start request timed out', async () => {
    const ready = withDriver();
    // A live session keeps the shared process (and connection) up while the
    // next start times out.
    await started(ready);
    ready.agent.holdNextNewSession = true;
    vi.useFakeTimers();
    try {
      const ctx = recordingContext();
      ready.driver.startSession(start({ sessionId: 'b2' }), ctx);
      await vi.advanceTimersByTimeAsync(SESSION_REQUEST_TIMEOUT_MS);
      expect(ctx.events.find((event) => event.type === 'ended')).toMatchObject({
        error: expect.stringMatching(/session\/new did not answer/),
      });
    } finally {
      vi.useRealTimers();
    }

    // The agent finally answers, naming the session it created; it is not
    // this driver's to keep, so it is closed rather than orphaned.
    ready.agent.answerNewSession();
    await vi.waitFor(() => expect(ready.agent.closed).toEqual(['s2']));
  });

  it('applies the mode and the model a session was started with', async () => {
    const ready = withDriver();
    await started(ready, { mode: 'plan', model: 'glm-5.3' });
    // Plan is entered from the asking mode, not from the `auto` session/new
    // starts in: a plan's approval offers to restore the mode it came from.
    expect(ready.agent.setModes).toEqual([
      { sessionId: 's1', modeId: 'default' },
      { sessionId: 's1', modeId: 'plan' },
    ]);
    // The profile's own model id is selected through the value Qwen Code
    // serves it as.
    expect(ready.agent.setOptions).toEqual([{ sessionId: 's1', configId: 'model', value: 'glm-5.3(openai)' }]);
  });

  it('applies a reasoning level the model has', async () => {
    const ready = withDriver();
    await started(ready, { effort: 'high' });
    expect(ready.agent.setOptions).toEqual([{ sessionId: 's1', configId: 'reasoning_effort', value: 'high' }]);
  });

  it('refuses a model the profiles do not offer', async () => {
    const ready = withDriver();
    const ctx = recordingContext();
    ready.driver.startSession(start({ model: 'gpt-9' }), ctx);
    expect((await ctx.ended()).error).toMatch(/does not offer the model 'gpt-9'/);
  });

  it('hands the session’s process the profile tokens, under the names its settings refer to', async () => {
    const ready = withDriver({ env: { PATH: '/bin', KEEP: 'yes' } });
    await started(ready);
    expect(ready.spawns[0]?.args).toEqual(['/fake/qwen/cli-entry.js', '--acp']);
    expect(ready.spawns[0]?.env.QWEN_HOME).toBe(ready.home);
    expect(ready.spawns[0]?.env[qwenKeyEnvName('p1', 'https://gateway.example/v1')]).toBe('sk-secret');
    expect(ready.spawns[0]?.env.QWEN_TELEMETRY_ENABLED).toBe('false');
    expect(ready.spawns[0]?.env.KEEP).toBe('yes');
  });

  it('keeps the host’s own OpenAI and Qwen variables out of the session’s process', async () => {
    const ready = withDriver({
      env: {
        PATH: '/bin',
        OPENAI_API_KEY: 'host-key',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_MODEL: 'gpt-4o',
        QWEN_MODEL: 'qwen3-coder',
      },
    });
    await started(ready);
    const env = ready.spawns[0]?.env ?? {};
    // The session runs on the profile, not on whatever OpenAI configuration
    // the machine the host happens to run on carries.
    expect(env.PATH).toBe('/bin');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_MODEL).toBeUndefined();
    expect(env.QWEN_MODEL).toBeUndefined();
    expect(env[qwenKeyEnvName('p1', 'https://gateway.example/v1')]).toBe('sk-secret');
  });

  it('does not keep a mode the agent refused, so the session is not treated as one it never entered', async () => {
    const ready = withDriver();
    // The agent offers `auto` only, so the switch to `yolo` is refused — what
    // an agent without that mode reports.
    ready.agent.modes = { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Auto' }] };
    const ctx = recordingContext({ permission: () => ({ outcome: 'selected', optionId: 'allow-once' }) });
    await started(ready, { mode: 'yolo' }, ctx);
    const errors = ctx.entries().filter((entry) => entry.entryType === 'error').map((entry) => entry.text);
    expect(errors.some((text) => text.includes("could not switch to the 'yolo' mode"))).toBe(true);
    // The session reports the mode the agent really is in, and an ask is still
    // made: `yolo` never took hold, so nothing is auto-approved.
    expect(infoEvents(ctx)[0]).toMatchObject({ mode: 'auto' });
    const answer = await ready.agent.requestPermission({
      sessionId: 's1',
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }],
      toolCall: { toolCallId: 'c1', title: 'Shell', rawInput: { command: 'ls' } },
    });
    expect(ctx.permissions).toHaveLength(1);
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  it('opens without announcing a version: the catalog carries it', async () => {
    const ready = withDriver();
    ready.agent.agentInfo = { name: 'qwen-code', title: 'Qwen Code', version: '0.25.2' };
    const ctx = await started(ready);
    expect(ctx.entries()).toEqual([]);
  });
});

describe('QwenSession updates', () => {
  it('turns the agent’s updates into transcript entries, reading the tool name from _meta', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    // An empty agent message chunk, which Qwen Code sends many of, shows nothing.
    ready.agent.message('s1', '');
    ready.agent.thought('s1', 'weighing options');
    ready.agent.message('s1', 'Here is the plan.');
    // The first update carries the title and no arguments, as Qwen Code sends it.
    ready.agent.send('session/update', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Shell',
        kind: 'execute',
        status: 'pending',
        rawInput: {},
        _meta: { toolName: 'run_shell_command' },
      },
    });
    // The running update carries the arguments.
    ready.agent.send('session/update', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'in_progress',
        title: 'Shell: npm ci',
        kind: 'execute',
        rawInput: { command: 'npm ci\nnpm test' },
        _meta: { toolName: 'run_shell_command' },
      },
    });
    ready.agent.toolResult('s1', 'c1', 'all green');

    await vi.waitFor(() => expect(ctx.entries().filter((entry) => entry.entryType === 'tool_result')).toHaveLength(1));
    const entries = ctx.entries();
    expect(entries.filter((entry) => entry.entryType === 'text' && entry.text === '')).toHaveLength(0);
    expect(entries).toContainEqual(expect.objectContaining({ entryType: 'thinking', text: 'weighing options' }));
    expect(entries).toContainEqual(expect.objectContaining({ entryType: 'text', role: 'agent', text: 'Here is the plan.' }));
    expect(entries).toContainEqual(
      expect.objectContaining({ entryType: 'tool_call', callId: 'c1', toolName: 'run_shell_command', kind: 'execute', title: 'Shell' }),
    );
    expect(entries).toContainEqual(expect.objectContaining({ entryType: 'tool_result', callId: 'c1', text: 'all green' }));
  });

  it('reports how full the context is', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    ready.agent.usage('s1', 5000, 200_000);
    await vi.waitFor(() => expect(infoEvents(ctx).some((event) => event.contextPercentage === 3)).toBe(true));
  });

  it('follows a mode the agent changes itself', async () => {
    const ready = withDriver();
    const ctx = await started(ready, { mode: 'plan' });
    ready.agent.update('s1', { sessionUpdate: 'current_mode_update', currentModeId: 'default' });
    await vi.waitFor(() => expect(infoEvents(ctx).some((event) => event.mode === 'default')).toBe(true));
  });
});

describe('QwenSession permissions', () => {
  it('asks with the agent’s own options and sends the chosen one back', async () => {
    const ready = withDriver();
    const ctx = recordingContext({
      permission: (request) => {
        expect(request).toMatchObject({
          requestId: 'c1',
          toolName: 'run_shell_command',
          kind: 'execute',
          title: 'rm -rf build',
          options: [
            { id: 'proceed_once', label: 'Allow', kind: 'allow_once' },
            { id: 'cancel', label: 'Reject', kind: 'reject_once' },
          ],
        });
        return { outcome: 'selected', optionId: 'proceed_once' };
      },
    });
    await started(ready, {}, ctx);
    const answer = await ready.agent.requestPermission({
      sessionId: 's1',
      options: [
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ],
      toolCall: { toolCallId: 'c1', title: 'Shell', kind: 'execute', rawInput: { command: 'rm -rf build' }, _meta: { toolName: 'run_shell_command' } },
    });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_once' } });
  });

  it('refuses the ask when nobody answered, rather than pretending a refusal', async () => {
    const ready = withDriver();
    const ctx = recordingContext({ permission: () => ({ outcome: 'cancelled', reason: 'timed out' }) });
    await started(ready, {}, ctx);
    const answer = await ready.agent.requestPermission({
      sessionId: 's1',
      options: [{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' }],
      toolCall: { toolCallId: 'c1', title: 'Shell', rawInput: { command: 'ls' } },
    });
    expect(answer).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('shows the agent’s question form and answers it by question position', async () => {
    const ready = withDriver();
    const ctx = recordingContext({
      question: (requestId, questions) => {
        expect(requestId).toBe('c1');
        expect(questions).toEqual([
          { question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] },
        ]);
        return { outcome: 'answered', answers: [{ type: 'selected', labels: ['Red'] }] };
      },
    });
    await started(ready, {}, ctx);
    const answer = await ready.agent.requestPermission({
      sessionId: 's1',
      options: [
        { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: 'c1',
        title: 'Ask user 1 question',
        kind: 'think',
        rawInput: { questions: [{ id: 'q0', question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
        _meta: { toolName: 'ask_user_question', qwenInteractionKind: 'user_question' },
      },
    });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_once' }, answers: { '0': 'Red' } });
  });

  it('cancels a question the user did not answer', async () => {
    const ready = withDriver();
    const ctx = recordingContext({ question: () => ({ outcome: 'cancelled', reason: 'the phone went away' }) });
    await started(ready, {}, ctx);
    const answer = await ready.agent.requestPermission({
      sessionId: 's1',
      options: [
        { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: 'c1',
        rawInput: { questions: [{ id: 'q0', question: 'Which color?' }] },
        _meta: { toolName: 'ask_user_question', qwenInteractionKind: 'user_question' },
      },
    });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'cancel' } });
  });

  it('shows a plan review as the plan plus the agent’s verdicts', async () => {
    const ready = withDriver();
    const ctx = recordingContext({
      plan: (requestId, options, revise) => {
        expect(requestId).toBe('c1');
        expect(options).toEqual([
          { id: 'restore_previous', label: 'Yes, restore previous mode (auto)' },
          { id: 'proceed_once', label: 'Yes, and manually approve edits' },
          { id: 'cancel', label: 'No, keep planning (esc)' },
        ]);
        expect(revise).toBe('cancel');
        return { outcome: 'selected', optionId: 'restore_previous' };
      },
    });
    await started(ready, {}, ctx);
    const answer = await ready.agent.requestPermission({
      sessionId: 's1',
      options: [
        { optionId: 'restore_previous', name: 'Yes, restore previous mode (auto)', kind: 'allow_once' },
        { optionId: 'proceed_once', name: 'Yes, and manually approve edits', kind: 'allow_once' },
        { optionId: 'cancel', name: 'No, keep planning (esc)', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: 'c1',
        title: 'Plan:',
        kind: 'switch_mode',
        content: [{ type: 'content', content: { type: 'text', text: '1. Do the thing\n2. Check it' } }],
        rawInput: { plan: '1. Do the thing\n2. Check it' },
        _meta: { toolName: 'exit_plan_mode' },
      },
    });
    expect(ctx.entries().some((entry) => entry.entryType === 'plan' && entry.text === '1. Do the thing\n2. Check it')).toBe(true);
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'restore_previous' } });
  });

  it('shows a file change’s diff before the card', async () => {
    const ready = withDriver();
    const ctx = recordingContext({ permission: () => ({ outcome: 'cancelled', reason: 'never mind' }) });
    await started(ready, {}, ctx);
    await ready.agent.requestPermission({
      sessionId: 's1',
      options: [{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' }],
      toolCall: {
        toolCallId: 'c1',
        title: 'Edit',
        kind: 'edit',
        content: [{ type: 'diff', path: 'src/a.ts', oldText: 'one', newText: 'two' }],
        rawInput: { file_path: 'src/a.ts', old_string: 'one', new_string: 'two' },
        _meta: { toolName: 'edit' },
      },
    });
    const diff = ctx.entries().find((entry) => entry.entryType === 'diff');
    expect(diff).toMatchObject({ path: 'src/a.ts', callId: 'c1' });
    expect(diff && 'lines' in diff ? diff.lines : []).toEqual([
      { type: 'del', text: 'one' },
      { type: 'add', text: 'two' },
    ]);
  });
});

describe('QwenSession commands', () => {
  it('lists the commands the agent announced', async () => {
    const ready = withDriver();
    await started(ready);
    ready.agent.update('s1', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'status', description: 'show version info', input: { hint: '' } }],
    });
    await vi.waitFor(async () => expect(await ready.session.listCommands?.()).toHaveLength(1));
    expect(await ready.session.listCommands?.()).toEqual([{ name: 'status', description: 'show version info' }]);
  });
});

describe('QwenSession steering', () => {
  it('hands a message typed during a turn to the agent’s next drain', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    let release: (() => void) | undefined;
    ready.agent.onPrompt = () => new Promise<string>((resolve) => (release = () => resolve('end_turn')));
    ready.session.prompt('build the parser');
    await vi.waitFor(() => expect(ready.agent.requests.some((r) => r.method === 'session/prompt')).toBe(true));
    ready.session.prompt('use a recursive descent one');

    const answer = await ready.agent.extRequest('craft/drainMidTurnQueue', { sessionId: 's1' });
    expect(answer.result).toEqual({ messages: ['use a recursive descent one'], hasQueuedPrompt: false });
    // A second drain finds nothing: the message was handed over once.
    const again = await ready.agent.extRequest('craft/drainMidTurnQueue', { sessionId: 's1' });
    expect(again.result).toEqual({ messages: [], hasQueuedPrompt: false });

    release?.();
    await vi.waitFor(() => expect(ctx.events.some((event) => event.type === 'turn' && event.state === 'idle')).toBe(true));
    expect(ready.agent.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(1);
  });

  it('tells the agent a slash command is waiting behind the turn, so its stop guard stays on', async () => {
    const ready = withDriver();
    await started(ready);
    const releases: Array<() => void> = [];
    ready.agent.onPrompt = () => new Promise<string>((resolve) => releases.push(() => resolve('end_turn')));
    ready.session.prompt('build the parser');
    await vi.waitFor(() => expect(ready.agent.requests.some((r) => r.method === 'session/prompt')).toBe(true));
    // A command cannot join the running turn, so it is queued behind it.
    ready.session.prompt('/status');

    const answer = await ready.agent.extRequest('craft/drainMidTurnQueue', {
      sessionId: 's1',
      todoStopGuardWatchQueuedPrompt: true,
    });
    expect(answer.result).toEqual({ messages: [], hasQueuedPrompt: true });

    // The turn ends, the queued command becomes its own turn, and the next
    // drain — of that turn — has nothing waiting behind it.
    releases[0]?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const after = await ready.agent.extRequest('craft/drainMidTurnQueue', {
      sessionId: 's1',
      todoStopGuardWatchQueuedPrompt: true,
    });
    expect(after.result).toEqual({ messages: [], hasQueuedPrompt: false });
    releases[1]?.();
  });

  it('prompts a message the turn never drained once the turn ends', async () => {
    const ready = withDriver();
    await started(ready);
    const prompts: string[] = [];
    const releases: Array<() => void> = [];
    ready.agent.onPrompt = (_sessionId, text) => {
      prompts.push(text);
      return new Promise<string>((resolve) => releases.push(() => resolve('end_turn')));
    };
    ready.session.prompt('one');
    await vi.waitFor(() => expect(prompts).toEqual(['one']));
    ready.session.prompt('two');
    releases[0]?.();
    await vi.waitFor(() => expect(prompts).toEqual(['one', 'two']));
    releases[1]?.();
  });

  it('refuses an extension method it does not know, at once', async () => {
    const ready = withDriver();
    await started(ready);
    const answer = await ready.agent.extRequest('qwen/something/unknown', { sessionId: 's1' });
    expect(answer.error).toMatchObject({ code: -32601 });
  });
});

describe('QwenSession options', () => {
  it('switches the mode with the agent’s own method and reports the new one', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    await ready.session.setOption('mode', 'yolo');
    expect(ready.agent.setModes.at(-1)).toEqual({ sessionId: 's1', modeId: 'yolo' });
    expect(infoEvents(ctx).some((event) => event.mode === 'yolo')).toBe(false);

    ready.agent.update('s1', { sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    await vi.waitFor(() => expect(infoEvents(ctx).some((event) => event.mode === 'plan')).toBe(true));
  });

  it('refuses a mode the driver does not have', async () => {
    const ready = withDriver();
    await started(ready);
    await expect(ready.session.setOption('mode', 'turbo')).rejects.toThrow(/no mode 'turbo'/);
  });

  it('passes the agent its own refusal for an unknown model', async () => {
    const ready = withDriver();
    await started(ready);
    await expect(ready.session.setOption('model', 'gpt-9')).rejects.toThrow(/does not offer the model/);
  });
});

describe('QwenSession resume', () => {
  it('continues the conversation the bridge names', async () => {
    const ready = withDriver();
    const ctx = await started(ready, { resume: 'old-session' });
    expect(ready.agent.resumed).toEqual([{ sessionId: 'old-session', cwd: '/work', mcpServers: [] }]);
    expect(ready.agent.newSessions).toEqual([]);
    expect(ctx.entries()).toEqual([]);
  });

  it('starts fresh with a notice when the conversation is gone', async () => {
    const ready = withDriver();
    ready.agent.resumeError = 'session is not resumable: old-session';
    const ctx = await started(ready, { resume: 'old-session' });
    expect(ready.agent.newSessions).toHaveLength(1);
    expect(ctx.entries()[0]).toMatchObject({ entryType: 'notice', kind: 'session_restart' });
  });

  it('says so when the agent offers no resume at all, rather than swapping silently', async () => {
    const ready = withDriver();
    ready.agent.supportsResume = false;
    const ctx = await started(ready, { resume: 'old-session' });
    expect(ready.agent.resumed).toEqual([]);
    expect(ready.agent.newSessions).toHaveLength(1);
    expect(ctx.entries()[0]).toMatchObject({ entryType: 'notice', kind: 'session_restart' });
  });
});

describe('QwenSession shutdown', () => {
  it('returns from end() when the agent never answers session/close', async () => {
    const ready = withDriver();
    await started(ready);
    ready.agent.ignoreClose = true;
    vi.useFakeTimers();
    try {
      const ending = ready.session.end();
      await vi.advanceTimersByTimeAsync(SESSION_REQUEST_TIMEOUT_MS);
      await ending;
      expect(ready.agent.closed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a turn locally when the agent ignores the cancel, and the next message still runs', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    ready.agent.ignoresCancel = true;
    const prompts: string[] = [];
    let release: ((stop: string) => void) | undefined;
    ready.agent.onPrompt = (_sessionId, text) => {
      prompts.push(text);
      return text === 'first' ? new Promise<string>((resolve) => (release = resolve)) : 'end_turn';
    };
    ready.session.prompt('first');
    await vi.waitFor(() => expect(prompts).toEqual(['first']));

    vi.useFakeTimers();
    try {
      await ready.session.interrupt();
      expect(ready.agent.notifications).toContainEqual({ method: 'session/cancel', params: { sessionId: 's1' } });
      await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS);
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'notice', kind: 'other', text: expect.stringMatching(/ended here/) }),
      );
      expect(ctx.events.filter((e) => e.type === 'turn' && e.state === 'idle')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }

    // The prompt the agent never answered must not hold the chain: the next
    // message reaches the agent and runs its own turn.
    ready.session.prompt('second');
    await vi.waitFor(() => expect(prompts).toEqual(['first', 'second']));
    await vi.waitFor(() => expect(ctx.events.filter((e) => e.type === 'turn' && e.state === 'idle')).toHaveLength(2));
    // Its late settlement does not open or end anything.
    release?.('end_turn');
  });

  it('answers the permission ask it was still waiting on with a cancellation', async () => {
    const ready = withDriver();
    const ctx = await started(ready, {}, recordingContext({ permission: () => new Promise<never>(() => {}) }));
    const asked = ready.agent.askPermission('s1', 'call-1');
    await vi.waitFor(() => expect(ctx.permissions).toHaveLength(1));
    await ready.session.end();
    await expect(asked).resolves.toMatchObject({ outcome: 'cancelled' });
  });
});

describe('QwenDriver conversations', () => {
  it('deletes a conversation’s transcript and plan file', async () => {
    const ready = withDriver();
    const chats = path.join(ready.home, 'projects', '-work', 'chats');
    mkdirSync(chats, { recursive: true });
    mkdirSync(path.join(ready.home, 'plans'), { recursive: true });
    writeFileSync(path.join(chats, 'abc.jsonl'), '{}');
    writeFileSync(path.join(chats, 'other.jsonl'), '{}');
    writeFileSync(path.join(ready.home, 'plans', 'abc.md'), '# plan');
    await ready.driver.deleteConversation?.('abc', '/work');
    expect(readFileSync(path.join(chats, 'other.jsonl'), 'utf8')).toBe('{}');
    expect(() => readFileSync(path.join(chats, 'abc.jsonl'), 'utf8')).toThrow();
    expect(() => readFileSync(path.join(ready.home, 'plans', 'abc.md'), 'utf8')).toThrow();
  });
});

describe('the Qwen Code runtime', () => {
  it('runs an operator-provided entry point instead of installing one', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codedeck-qwen-'));
    try {
      const cli = path.join(home, 'my-qwen.js');
      writeFileSync(cli, '// a standalone CLI\n');
      const ready = withDriver({ qwenPath: cli });
      await started(ready);
      expect(ready.spawns[0]?.command).toBe(process.execPath);
      expect(ready.spawns[0]?.args).toEqual([cli, '--acp']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports a path that is not a file', () => {
    const ready = withDriver({ qwenPath: '/nope/missing.js' });
    ready.driver.setUnavailable('CODEDECK_QWEN_PATH points at /nope/missing.js, which is not a file.');
    expect(ready.driver.info().unavailableReason).toMatch(/which is not a file/);
  });
});
