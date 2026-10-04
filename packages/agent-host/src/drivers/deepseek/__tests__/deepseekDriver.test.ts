import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { recordingContext, type RecordingContext } from '../../../__tests__/context';
import type { StartSession } from '../../../types';
import type { DriverSession } from '../../../driver';
import { DeepSeekDriver } from '../driver';
import { bridgeSocketPath } from '../bridge';
import { QUESTION_MARKER } from '../plugin';
import { DeepSeekMcp } from '../mcp';
import { DeepSeekRuntime, dshHomeDir } from '../runtime';
import { FakeHarness } from './fakeHarness';

/** A harness home in a temp directory, with the profile directory the CLI
 *  would create on its first run. */
function harnessHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-'));
  mkdirSync(path.join(home, 'profiles', 'acp'), { recursive: true });
  writeFileSync(path.join(home, 'profiles', 'acp', 'cordis.patch.yml'), '# the profile layer\n[]\n');
  return home;
}

interface Harness {
  driver: DeepSeekDriver;
  runtime: DeepSeekRuntime;
  harness: FakeHarness;
  home: string;
  spawns: Array<{ command: string; args: string[]; env: Record<string, string> }>;
  /** What the runtime logged (the harness's own stderr lines included). */
  logs: string[];
  /** The session the last `started()` call created. */
  session: DriverSession;
}

/** A driver over a scripted harness. The install seam never downloads: the
 *  fake spawn answers instead. */
function withDriver(
  options: { idleCloseMs?: number; env?: NodeJS.ProcessEnv; dshPath?: string; log?: (line: string) => void } = {},
): Harness {
  const home = harnessHome();
  const harness = new FakeHarness();
  const spawns: Harness['spawns'] = [];
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const mcp = new DeepSeekMcp({ profileDir: path.join(home, 'profiles', 'acp'), log });
  const runtime = new DeepSeekRuntime({
    ...(options.dshPath !== undefined ? { dshPath: options.dshPath } : {}),
    home,
    cacheDir: path.join(home, 'agents'),
    installDsh: async () => '/fake/dsh/lib/bin.js',
    configVersion: () => mcp.version,
    spawnFn: ((command: string, args: string[], opts: { env: Record<string, string> }) => {
      spawns.push({ command, args, env: opts.env });
      return harness.child;
    }) as never,
    idleCloseMs: options.idleCloseMs ?? 0,
    log: options.log ?? log,
  });
  const driver = DeepSeekDriver.create({
    runtime,
    home,
    mcp,
    baseEnv: options.env ?? ({} as NodeJS.ProcessEnv),
    log: options.log ?? log,
  });
  return { driver, runtime, harness, home, spawns, logs, session: undefined as never };
}

function start(overrides: Partial<StartSession> = {}): StartSession {
  return { sessionId: 'b1', agent: 'deepseek-harness', cwd: '/work', ...overrides };
}

/** Start a session and wait for it to accept prompts. The session is kept
 *  on the harness so a test can prompt it and change its options. */
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

describe('DeepSeekDriver.info', () => {
  it('advertises what the ACP surface carries, and what it does not', () => {
    const { driver } = withDriver();
    const info = driver.info();
    expect(info.id).toBe('deepseek-harness');
    expect(info.displayName).toBe('DeepSeek Harness');
    expect(info.modes?.map((mode) => mode.id)).toEqual(['ask', 'default']);
    expect(info.efforts?.map((effort) => effort.id)).toEqual(['off', 'low', 'high', 'max']);
    expect(info.defaultMode).toBe('ask');
    expect(info.supports).toEqual({
      models: true,
      usage: false,
      providers: true,
      gsd: true,
      interrupt: true,
      commands: true,
      plugins: true,
      mcp: true,
      tasks: false,
    });
    expect(info.credentials).toEqual([{ id: 'deepseek_api_key', label: 'DeepSeek API key', envVar: 'DEEPSEEK_API_KEY' }]);
  });
});

describe('DeepSeekSession startup', () => {
  it('starts a session and reports its identity', async () => {
    const ready = withDriver();
    const ctx = await started(ready, { model: '["deepseek-official","deepseek-v4-pro"]', effort: 'low' });

    expect(ready.harness.newSessions).toEqual([{ cwd: '/work', mcpServers: [] }]);
    // The model is selected by the harness's own opaque value; the effort by
    // its plain id.
    expect(ready.harness.setOptions).toEqual([
      { sessionId: 's1', configId: 'model', value: '["deepseek-official","deepseek-v4-pro"]' },
      { sessionId: 's1', configId: 'reasoning_effort', value: 'low' },
    ]);
    expect(infoEvents(ctx)[0]).toEqual({ type: 'info', nativeSessionId: 's1', model: 'DeepSeek-V4-Pro', mode: 'ask' });
    expect(ctx.entries().map((entry) => entry.entryType)).toEqual(['status']);
  });

  it('accepts a model named by its plain id, as a provider profile names one', async () => {
    const ready = withDriver();
    await started(ready, { model: 'deepseek-v4-pro' });
    expect(ready.harness.setOptions[0]).toEqual({
      sessionId: 's1',
      configId: 'model',
      value: '["deepseek-official","deepseek-v4-pro"]',
    });
  });

  it('refuses a model the harness does not offer', async () => {
    const ready = withDriver();
    const ctx = recordingContext();
    ready.driver.startSession(start({ model: 'gpt-9' }), ctx);
    const ended = await ctx.ended();
    expect(ended.error).toMatch(/does not offer the model 'gpt-9'/);
    expect(ctx.entries()[0]).toMatchObject({ entryType: 'error' });
  });

  it('keeps going, with an error entry, when a provider-bound model is unknown', async () => {
    const ready = withDriver();
    const ctx = await started(ready, {
      model: 'kimi-k2',
      provider: { id: 'p1', baseUrl: 'https://gateway.example/v1', authToken: 'sk-x', models: [] },
    });
    expect(ready.harness.setOptions.some((option) => option.configId === 'model')).toBe(true);
    expect(ctx.entries().some((entry) => entry.entryType === 'error' && /kimi-k2/.test(entry.text))).toBe(true);
  });

  it('reports an effort the model does not have instead of refusing the session', async () => {
    const ready = withDriver();
    // A model without a reasoning option (a gateway's, say).
    ready.harness.options = [ready.harness.options[0]!];
    const ctx = await started(ready, { effort: 'max' });
    expect(ctx.entries().some((entry) => entry.entryType === 'error' && /no reasoning level/.test(entry.text))).toBe(true);
    expect(ready.harness.setOptions).toEqual([]);
  });

  it('reports a start that failed as an error entry and an ended session', async () => {
    const ready = withDriver();
    ready.harness.newSessionError = 'the profile could not be loaded';
    const ctx = recordingContext();
    ready.driver.startSession(start(), ctx);
    expect((await ctx.ended()).error).toMatch(/the profile could not be loaded/);
  });

  it('lets go of the harness process when a session is closed while starting', async () => {
    const ready = withDriver();
    const ctx = recordingContext();
    const session = ready.driver.startSession(start(), ctx);
    await session.end();
    await vi.waitFor(() => expect(ready.harness.child.killed).toContain('SIGTERM'));
    expect(ctx.events.some((event) => event.type === 'ended')).toBe(false);
  });
});

describe('DeepSeekSession environment', () => {
  it('hands the session its provider binding, replacing the harness namespace', async () => {
    const ready = withDriver({ env: { PATH: '/bin', DEEPSEEK_API_KEY: 'native-key', KEEP: 'yes' } });
    await started(ready, {
      provider: { id: 'p1', baseUrl: 'https://gateway.example/v1', authToken: 'sk-gateway', models: [] },
    });
    expect(ready.spawns[0]?.env.DEEPSEEK_BASE_URL).toBe('https://gateway.example/v1');
    expect(ready.spawns[0]?.env.DEEPSEEK_API_KEY).toBe('sk-gateway');
    expect(ready.spawns[0]?.env.KEEP).toBe('yes');
  });

  it('leaves the operator environment alone for a native session', async () => {
    const ready = withDriver({ env: { PATH: '/bin', DEEPSEEK_BASE_URL: 'https://relay.example' } });
    await started(ready);
    expect(ready.spawns[0]?.env.DEEPSEEK_BASE_URL).toBe('https://relay.example');
  });

  it('refuses a provider profile with an insecure base URL before starting', () => {
    const ready = withDriver();
    const ctx = recordingContext();
    expect(() =>
      ready.driver.startSession(
        start({ provider: { id: 'p1', baseUrl: 'http://gateway.example/v1', authToken: 'sk', models: [] } }),
        ctx,
      ),
    ).toThrow(/insecure base URL/);
  });

  it('runs one harness process per environment and shares it between sessions', async () => {
    const ready = withDriver();
    await started(ready, { sessionId: 'b1' });
    await started(ready, { sessionId: 'b2' });
    const gateway = { id: 'p1', baseUrl: 'https://gateway.example/v1', authToken: 'sk', models: [] };
    await started(ready, { sessionId: 'b3', provider: gateway });
    expect(ready.spawns).toHaveLength(2);
  });
});

describe('DeepSeekSession updates', () => {
  it('turns the harness updates into transcript entries', async () => {
    const ready = withDriver();
    const ctx = await started(ready);

    ready.harness.thought('s1', 'weighing options');
    ready.harness.message('s1', 'Here is the plan.');
    ready.harness.toolCall('s1', 'c1', 'bash', { command: 'npm ci\nnpm test' });
    ready.harness.toolResult('s1', 'c1', 'all green');
    ready.harness.toolCall('s1', 'c2', 'edit', { file_path: 'src/a.ts', old_string: 'one', new_string: 'two' });
    ready.harness.toolResult('s1', 'c2', '');
    ready.harness.toolCall('s1', 'c3', 'todo_write', { todos: [{ content: 'Ship it', status: 'in_progress' }] });

    await vi.waitFor(() => expect(ctx.entries()).toHaveLength(10));
    const entries = ctx.entries();
    expect(entries[0]).toMatchObject({ entryType: 'status' });
    expect(entries[1]).toMatchObject({ entryType: 'thinking', text: 'weighing options' });
    expect(entries[2]).toMatchObject({ entryType: 'text', role: 'agent', text: 'Here is the plan.' });
    expect(entries[3]).toMatchObject({
      entryType: 'tool_call',
      callId: 'c1',
      kind: 'execute',
      title: 'npm ci…',
      input: 'npm ci\nnpm test',
    });
    expect(entries[4]).toMatchObject({ entryType: 'tool_result', callId: 'c1', text: 'all green' });
    expect(entries[5]).toMatchObject({ entryType: 'tool_call', callId: 'c2', kind: 'edit', locations: ['src/a.ts'] });
    // An empty result still marks the call finished, and the file change is
    // reconstructed from the call's own arguments.
    expect(entries[6]).toMatchObject({ entryType: 'tool_result', callId: 'c2', text: '' });
    expect(entries[7]).toMatchObject({ entryType: 'diff', path: 'src/a.ts', callId: 'c2' });
    expect(entries[8]).toMatchObject({ entryType: 'tool_call', callId: 'c3', kind: 'think' });
    expect(entries[9]).toMatchObject({ entryType: 'todos', items: [{ text: 'Ship it', status: 'in_progress' }] });
  });

  it('reports how full the context is, and only when it changed', async () => {
    const ready = withDriver();
    const ctx = await started(ready);

    ready.harness.usage('s1', 5000, 10_000);
    ready.harness.usage('s1', 5000, 10_000);
    ready.harness.usage('s1', 7500, 10_000);
    await vi.waitFor(() => expect(infoEvents(ctx)).toHaveLength(3));
    expect(infoEvents(ctx).map((event) => [event.contextWindow, event.contextPercentage])).toEqual([
      [undefined, undefined],
      [10_000, 50],
      [10_000, 75],
    ]);
  });

  it('drops an update for a session nobody serves', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    ready.harness.message('other', 'not mine');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ctx.entries().map((entry) => entry.entryType)).toEqual(['status']);
  });
});

describe('DeepSeekSession permissions', () => {
  /** Drive one scripted turn that asks for `callId`, and answer with what
   *  the harness received for its ask. */
  async function askThrough(
    ready: Harness,
    ctx: RecordingContext,
    callId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ outcome: string; optionId?: string } | undefined> {
    ready.harness.toolCall('s1', callId, toolName, input);
    let answer: { outcome: string; optionId?: string } | undefined;
    let answered = false;
    ready.harness.onPrompt = async (sessionId) => {
      answer = await ready.harness.askPermission(sessionId, callId);
      answered = true;
      return 'end_turn';
    };
    ready.session.prompt('go');
    await vi.waitFor(() => expect(answered).toBe(true));
    return answer;
  }

  it('asks the phone with the tool call the harness named, and allows on Allow', async () => {
    const ready = withDriver();
    const ctx = recordingContext({
      permission: (request) => {
        expect(request).toMatchObject({
          requestId: 'c1',
          toolName: 'bash',
          kind: 'execute',
          title: 'rm -rf build',
          rawInput: { command: 'rm -rf build' },
          options: [
            { id: 'allow', label: 'Allow', kind: 'allow_once' },
            { id: 'deny', label: 'Deny', kind: 'reject_once' },
          ],
        });
        return { outcome: 'selected', optionId: 'allow' };
      },
    });
    await started(ready, {}, ctx);
    expect(await askThrough(ready, ctx, 'c1', 'bash', { command: 'rm -rf build' })).toEqual({
      outcome: 'selected',
      optionId: 'allow-once',
    });
  });

  it('refuses the ask when the phone refuses', async () => {
    const ready = withDriver();
    const ctx = recordingContext({ permission: () => ({ outcome: 'selected', optionId: 'deny' }) });
    await started(ready, {}, ctx);
    expect(await askThrough(ready, ctx, 'c2', 'bash', { command: 'ls' })).toEqual({
      outcome: 'selected',
      optionId: 'reject-once',
    });
  });

  it('cancels the ask when nobody answered, rather than pretending a refusal', async () => {
    const ready = withDriver();
    const ctx = recordingContext({ permission: () => ({ outcome: 'cancelled', reason: 'timed out' }) });
    await started(ready, {}, ctx);
    expect(await askThrough(ready, ctx, 'c3', 'bash', { command: 'ls' })).toEqual({ outcome: 'cancelled' });
  });

  it('allows without asking in the auto-approve mode', async () => {
    const ready = withDriver();
    const ctx = recordingContext({ permission: () => ({ outcome: 'selected', optionId: 'deny' }) });
    await started(ready, { mode: 'default' }, ctx);
    expect(await askThrough(ready, ctx, 'c4', 'bash', { command: 'ls' })).toEqual({
      outcome: 'selected',
      optionId: 'allow-once',
    });
    expect(ctx.permissions).toHaveLength(0);
  });
});

describe('DeepSeekSession turns', () => {
  it('runs one prompt at a time and marks each turn', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    const prompts: string[] = [];
    const releases: Array<() => void> = [];
    ready.harness.onPrompt = async (sessionId, text) => {
      void sessionId;
      prompts.push(text);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return 'end_turn';
    };
    ready.session.prompt('one');
    ready.session.prompt('two');
    // The second prompt waits for the first turn to be over: ACP refuses one
    // while another is in flight.
    await vi.waitFor(() => expect(prompts).toEqual(['one']));
    releases[0]?.();
    await vi.waitFor(() => expect(prompts).toEqual(['one', 'two']));
    releases[1]?.();
    await vi.waitFor(() => expect(ctx.entries().filter((entry) => entry.entryType === 'turn_complete')).toHaveLength(2));
    expect(ctx.events.filter((event) => event.type === 'turn')).toHaveLength(4);
  });

  it('reports a failed turn and completes it', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    ready.harness.onPrompt = () => {
      throw new Error('DeepSeek Messages transport failed');
    };
    ready.session.prompt('go');
    await vi.waitFor(() =>
      expect(ctx.entries().some((entry) => entry.entryType === 'error' && /transport failed/.test(entry.text))).toBe(true),
    );
    expect(ctx.entries().filter((entry) => entry.entryType === 'turn_complete').length).toBeGreaterThan(0);
  });

  it('cancels the running turn on interrupt', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    // Never resolves on its own: only the cancel notification ends it.
    ready.harness.onPrompt = () => new Promise<string>(() => {});
    ready.session.prompt('long one');
    await vi.waitFor(() =>
      expect(ready.harness.requests.some((request) => request.method === 'session/prompt')).toBe(true),
    );
    await ready.session.interrupt();
    await vi.waitFor(() => expect(ready.harness.notifications.some((n) => n.method === 'session/cancel')).toBe(true));
    await vi.waitFor(() => expect(ctx.entries().some((entry) => entry.entryType === 'turn_complete')).toBe(true));
  });
});

describe('DeepSeekSession options', () => {
  it('applies a model and an effort mid-session and reports the resolved model', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    await ready.session.setOption('model', '["deepseek-official","deepseek-v4-pro"]');
    await ready.session.setOption('effort', 'off');
    await ready.session.setOption('mode', 'default');
    expect(ready.harness.setOptions.slice(-2)).toEqual([
      { sessionId: 's1', configId: 'model', value: '["deepseek-official","deepseek-v4-pro"]' },
      { sessionId: 's1', configId: 'reasoning_effort', value: 'off' },
    ]);
    expect(infoEvents(ctx).some((event) => event.model === 'DeepSeek-V4-Pro')).toBe(true);
  });

  it('refuses a mode the driver does not have', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    await expect(ready.session.setOption('mode', 'plan')).rejects.toThrow(/no mode 'plan'/);
  });

  it('passes the harness its own refusal for an unknown effort', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    ready.harness.acceptsOptions = false;
    await expect(ready.session.setOption('effort', 'turbo')).rejects.toThrow(/Invalid params/);
  });
});

describe('DeepSeekSession resume', () => {
  it('continues the conversation the bridge names', async () => {
    const ready = withDriver();
    await started(ready, { resume: 'old-session' });
    expect(ready.harness.resumed).toEqual([{ sessionId: 'old-session', cwd: '/work', mcpServers: [] }]);
    expect(ready.harness.newSessions).toEqual([]);
  });

  it('starts fresh with a notice when the conversation is gone', async () => {
    const ready = withDriver();
    ready.harness.resumeError = 'session is not resumable: old-session';
    const ctx = await started(ready, { resume: 'old-session' });
    expect(ready.harness.newSessions).toHaveLength(1);
    expect(ctx.entries()[0]).toMatchObject({ entryType: 'notice', kind: 'session_restart' });
    expect(ctx.logs.some((line) => /could not resume old-session/.test(line))).toBe(true);
  });

  it('does not try a resume the harness says it does not support', async () => {
    const ready = withDriver();
    ready.harness.supportsResume = false;
    await started(ready, { resume: 'old-session' });
    expect(ready.harness.resumed).toEqual([]);
    expect(ready.harness.newSessions).toHaveLength(1);
  });
});

describe('DeepSeekSession lifecycle', () => {
  it('closes the session and stops the idle harness process', async () => {
    const ready = withDriver();
    await started(ready);
    await ready.session.end();
    expect(ready.harness.closed).toEqual(['s1']);
    await vi.waitFor(() => expect(ready.harness.child.killed).toContain('SIGTERM'));
  });

  it('ends every session of a harness process that goes away', async () => {
    const ready = withDriver();
    const first = await started(ready, { sessionId: 'b1' });
    const second = await started(ready, { sessionId: 'b2' });
    ready.harness.child.crash(7);
    expect((await first.ended()).error).toMatch(/exited \(code 7\)/);
    expect((await second.ended()).error).toMatch(/exited \(code 7\)/);
  });

  it('keeps an unused process for the idle grace period', async () => {
    const ready = withDriver({ idleCloseMs: 60_000 });
    await started(ready);
    await ready.session.end();
    expect(ready.harness.child.killed).toEqual([]);
    await ready.driver.shutdown();
    expect(ready.harness.child.killed).toContain('SIGTERM');
  });
});

describe('DeepSeekDriver model catalog', () => {
  it('lists the harness catalog from a probe session, once', async () => {
    const ready = withDriver();
    const models = await ready.driver.listModels();
    expect(models.defaultModel).toBe('deepseek-v4-flash');
    expect(models.models).toEqual([
      { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', provider: 'DeepSeek' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro', provider: 'DeepSeek' },
    ]);
    await ready.driver.listModels();
    expect(ready.harness.newSessions).toHaveLength(1);
    expect(ready.harness.closed).toEqual(['s1']);
  });

  it('asks again after an empty catalog rather than remembering nothing', async () => {
    const ready = withDriver();
    ready.harness.options = [];
    expect(await ready.driver.listModels()).toEqual({ models: [] });
    ready.harness.options = [{ id: 'model', type: 'select', currentValue: 'x', options: [{ value: 'x', name: 'X' }] }];
    expect((await ready.driver.listModels()).models).toHaveLength(1);
  });

  it('answers an empty list when the harness cannot be reached at all', async () => {
    const home = harnessHome();
    const runtime = new DeepSeekRuntime({
      home,
      cacheDir: path.join(home, 'agents'),
      installDsh: async () => {
        throw new Error('no network');
      },
      idleCloseMs: 0,
      log: () => {},
    });
    const driver = DeepSeekDriver.create({ runtime, home, log: () => {} });
    expect(await driver.listModels()).toEqual({ models: [] });
  });
});

describe('DeepSeekDriver credential check', () => {
  it('checks the DeepSeek key against the DeepSeek API', async () => {
    const httpGet = vi.fn(async () => ({ status: 200 }));
    const ready = withDriver();
    const driver = DeepSeekDriver.create({ runtime: ready.runtime, home: ready.home, baseEnv: {} as NodeJS.ProcessEnv, httpGet, log: () => {} });
    expect(await driver.checkCredential('deepseek_api_key', 'sk-1')).toBe(true);
    expect(httpGet).toHaveBeenCalledWith('https://api.deepseek.com/models', { authorization: 'Bearer sk-1' });
    expect(await driver.checkCredential('other', 'sk-1')).toBeUndefined();
  });

  it('reports a refused key, and claims nothing on a network error', async () => {
    const ready = withDriver();
    const refusing = DeepSeekDriver.create({
      runtime: ready.runtime,
      home: ready.home,
      baseEnv: {} as NodeJS.ProcessEnv,
      httpGet: async () => ({ status: 401 }),
      log: () => {},
    });
    expect(await refusing.checkCredential('deepseek_api_key', 'sk-bad')).toBe(false);

    const unreachable = DeepSeekDriver.create({
      runtime: ready.runtime,
      home: ready.home,
      baseEnv: {} as NodeJS.ProcessEnv,
      httpGet: async () => {
        throw new Error('ECONNREFUSED');
      },
      log: () => {},
    });
    expect(await unreachable.checkCredential('deepseek_api_key', 'sk-1')).toBeUndefined();
  });

  it('checks a key against the gateway it belongs to, not the DeepSeek API', async () => {
    const httpGet = vi.fn(async () => ({ status: 200 }));
    const ready = withDriver();
    const driver = DeepSeekDriver.create({
      runtime: ready.runtime,
      home: ready.home,
      baseEnv: { DEEPSEEK_BASE_URL: 'https://gateway.example' } as NodeJS.ProcessEnv,
      httpGet,
      log: () => {},
    });
    expect(await driver.checkCredential('deepseek_api_key', 'sk-gateway')).toBe(true);
    // The list the gateway serves is the one call every gateway has, and the
    // one this driver reads its catalog from.
    expect(httpGet).toHaveBeenCalledWith('https://gateway.example/v1/models', { authorization: 'Bearer sk-gateway' });
  });
});

describe('session MCP status', () => {
  it('reports the profile servers, with what the harness said about them', async () => {
    const ready = withDriver();
    await started(ready);
    const session = ready.session;
    expect((await session.mcpStatus?.())?.servers).toEqual([]);

    await ready.driver.mcp.act('add', [{ name: 'demo', setup: { type: 'stdio', command: '/usr/bin/demo' } }], []);
    await ready.driver.mcp.act('add', [{ name: 'fresh', setup: { type: 'http', url: 'https://mcp.example/mcp' } }], []);
    expect(readFileSync(path.join(ready.home, 'profiles', 'acp', 'cordis.patch.yml'), 'utf8')).toMatch(/codedeck-mcp-demo/);

    // The harness's own log is the only place it reports a failed server.
    ready.harness.child.stderr.write('mcp-client(demo): tool registration failed, no tools registered: boom\n');
    await vi.waitFor(() => expect(ready.logs.some((line) => /mcp-client\(demo\)/.test(line))).toBe(true));

    const status = await session.mcpStatus?.();
    expect(status?.servers).toEqual([
      // The harness complained about this one: it has no tools.
      { name: 'demo', status: 'failed', error: expect.stringMatching(/boom/) },
      // Configured after this process started: not loaded yet.
      { name: 'fresh', status: 'pending' },
    ]);
    expect(status?.toggles).toBe(false);
    await expect(session.toggleMcp?.('demo', false)).rejects.toThrow(/when it starts/);
  });

  it('reports a server the running harness has loaded as connected', async () => {
    const ready = withDriver();
    // Configured before the session starts, so the process it spawns loads
    // it: this is the state every session of a bridge restart begins in.
    await ready.driver.mcp.act('add', [{ name: 'demo', setup: { type: 'stdio', command: '/usr/bin/demo' } }], []);
    await started(ready);
    expect((await ready.session.mcpStatus?.())?.servers).toEqual([{ name: 'demo', status: 'connected' }]);
  });

  it('reports a server switched off in the profile as disabled', async () => {
    const ready = withDriver();
    await started(ready);
    await ready.driver.mcp.act('add', [{ name: 'demo', setup: { type: 'stdio', command: '/usr/bin/demo' } }], []);
    await ready.driver.mcp.act('disable', [], ['demo']);
    expect((await ready.session.mcpStatus?.())?.servers).toEqual([{ name: 'demo', status: 'disabled' }]);
  });
});

describe('the harness runtime', () => {
  it('is resolved — and installed — as the driver is created, not on the first session', async () => {
    const home = harnessHome();
    const installs: number[] = [];
    const runtime = new DeepSeekRuntime({
      home,
      cacheDir: path.join(home, 'agents'),
      installDsh: async () => {
        installs.push(Date.now());
        return '/fake/dsh/lib/bin.js';
      },
      idleCloseMs: 0,
      log: () => {},
    });
    const driver = DeepSeekDriver.create({ runtime, home, log: () => {} });
    void driver;
    // Nothing has started a session; the runtime is already on its way.
    await vi.waitFor(() => expect(installs).toHaveLength(1));
    // And a session does not ask for it again.
    await driver.listModels();
    expect(installs).toHaveLength(1);
  });

  it('reports a runtime it could not fetch, and keeps the agent listed', async () => {
    const home = harnessHome();
    const logs: string[] = [];
    const runtime = new DeepSeekRuntime({
      home,
      cacheDir: path.join(home, 'agents'),
      installDsh: async () => {
        throw new Error('no network');
      },
      idleCloseMs: 0,
      log: (line) => logs.push(line),
    });
    const driver = DeepSeekDriver.create({ runtime, home, log: (line) => logs.push(line) });
    await vi.waitFor(() => expect(logs.some((line) => /not ready yet: no network/.test(line))).toBe(true));
    expect(driver.info().unavailableReason).toBeUndefined();
  });
});

describe('a gateway', () => {
  const gatewayEnv = (base: string, key = 'sk-gateway'): NodeJS.ProcessEnv =>
    ({ DEEPSEEK_BASE_URL: base, DEEPSEEK_API_KEY: key }) as NodeJS.ProcessEnv;

  it('writes the models the gateway serves into the harness profile, as the host starts', async () => {
    const ready = withDriver({ env: gatewayEnv('http://gateway.example:3458') });
    ready.driver = DeepSeekDriver.create({
      runtime: ready.runtime,
      home: ready.home,
      baseEnv: gatewayEnv('http://gateway.example:3458'),
      httpGet: async (url, headers) => {
        expect(url).toBe('http://gateway.example:3458/v1/models');
        expect(headers.authorization).toBe('Bearer sk-gateway');
        return { status: 200, text: JSON.stringify({ data: [{ id: 'kimi-k2' }, { id: 'glm-4.6', context_length: 200_000 }] }) };
      },
      log: () => {},
    });
    await vi.waitFor(() =>
      expect(readFileSync(path.join(ready.home, 'profiles', 'acp', 'cordis.patch.yml'), 'utf8')).toMatch(/kimi-k2/),
    );
    const layer = readFileSync(path.join(ready.home, 'profiles', 'acp', 'cordis.patch.yml'), 'utf8');
    // The row the harness reads: the endpoint, and the catalog it may serve.
    expect(layer).toMatch(/id: llm-deepseek/);
    expect(layer).toMatch(/baseURL: http:\/\/gateway\.example:3458/);
    expect(layer).toMatch(/contextWindow: 200000/);
    // Its own block, and nothing else of ours: the MCP list is another one.
    expect(layer).toMatch(/CodeDeck\+ gateway catalog/);
    expect(layer).not.toMatch(/CodeDeck\+ MCP servers/);
  });

  it('leaves the harness catalog alone when the gateway does not answer', async () => {
    const ready = withDriver();
    const driver = DeepSeekDriver.create({
      runtime: ready.runtime,
      home: ready.home,
      baseEnv: gatewayEnv('http://gateway.example:3458'),
      httpGet: async () => {
        throw new Error('ECONNREFUSED');
      },
      log: () => {},
    });
    await driver.listModels();
    expect(readFileSync(path.join(ready.home, 'profiles', 'acp', 'cordis.patch.yml'), 'utf8')).not.toMatch(/llm-deepseek/);
  });

  it('takes its catalog back out when no gateway is configured any more', async () => {
    const ready = withDriver();
    const layer = path.join(ready.home, 'profiles', 'acp', 'cordis.patch.yml');
    writeFileSync(
      layer,
      `# the profile

# --- CodeDeck+ gateway catalog: written from the gateway's own model list; everything outside this block is yours ---
- id: llm-deepseek
  config:
    baseURL: http://old.example
# --- end CodeDeck+ gateway catalog ---
`,
    );
    const driver = DeepSeekDriver.create({ runtime: ready.runtime, home: ready.home, baseEnv: {} as NodeJS.ProcessEnv, log: () => {} });
    await driver.listModels();
    const after = readFileSync(layer, 'utf8');
    expect(after).not.toMatch(/llm-deepseek/);
    expect(after).toMatch(/# the profile/);
  });
});

describe('slash commands', () => {
  /** A stand-in for the command plugin: it answers over the socket the driver
   *  asks on, and records what it was asked. */
  async function commandBridge(
    home: string,
    answer: (request: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<{ requests: Array<Record<string, unknown>>; close: () => void }> {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((connection: Socket) => {
      connection.setEncoding('utf8');
      let buffered = '';
      connection.on('data', (chunk: string) => {
        buffered += chunk;
        const end = buffered.indexOf('\n');
        if (end < 0) return;
        const request = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>;
        requests.push(request);
        connection.write(`${JSON.stringify({ id: request.id, ...answer(request) })}\n`);
      });
      connection.on('error', () => {});
    });
    const socket = bridgeSocketPath(home);
    mkdirSync(path.dirname(socket), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    return { requests, close: () => server.close() };
  }

  const listing = (): Record<string, unknown> => ({
    ok: true,
    commands: [{ name: 'compact', description: 'Compact the conversation', hint: '[<focus>]' }],
  });

  it('lists what the harness has, and runs a typed command rather than prompting', async () => {
    const ready = withDriver();
    const bridge = await commandBridge(ready.home, (request) =>
      request.method === 'list' ? listing() : { ok: true, result: { kind: 'success', text: 'Compacted 12 messages.' } },
    );
    const ctx = await started(ready);
    expect(await ready.session.listCommands?.()).toEqual([
      { name: 'compact', description: 'Compact the conversation', argumentHint: '[<focus>]' },
    ]);

    ready.session.prompt('/compact keep the decisions');
    await vi.waitFor(() => expect(bridge.requests.some((request) => request.method === 'run')).toBe(true));
    const run = bridge.requests.find((request) => request.method === 'run')!;
    expect(run).toMatchObject({ sessionId: 's1', line: '/compact keep the decisions' });
    // The command's own words are in the transcript, and the harness was
    // never asked to prompt the model with a slash line.
    await vi.waitFor(() =>
      expect(ctx.entries().some((entry) => entry.entryType === 'text' && /Compacted 12 messages/.test(entry.text))).toBe(true),
    );
    expect(ready.harness.requests.some((request) => request.method === 'session/prompt')).toBe(false);
    bridge.close();
  });

  it('reports a command that failed', async () => {
    const ready = withDriver();
    const bridge = await commandBridge(ready.home, (request) =>
      request.method === 'list' ? listing() : { ok: true, result: { kind: 'error', text: 'nothing to compact' } },
    );
    const ctx = await started(ready);
    ready.session.prompt('/compact');
    await vi.waitFor(() =>
      expect(ctx.entries().some((entry) => entry.entryType === 'error' && /nothing to compact/.test(entry.text))).toBe(true),
    );
    bridge.close();
  });

  it('sends a slash line the harness does not have to the model, as text', async () => {
    const ready = withDriver();
    const bridge = await commandBridge(ready.home, (request) => (request.method === 'list' ? listing() : { ok: false }));
    const ctx = await started(ready);
    ready.session.prompt('/etc/hosts is missing');
    await vi.waitFor(() =>
      expect(ready.harness.requests.some((request) => request.method === 'session/prompt')).toBe(true),
    );
    expect(bridge.requests.some((request) => request.method === 'run')).toBe(false);
    expect(ctx.entries().length).toBeGreaterThan(0);
    bridge.close();
  });

  it('runs the session normally when nothing answers on the command socket', async () => {
    const ready = withDriver();
    const ctx = await started(ready);
    expect(await ready.session.listCommands?.()).toEqual([]);
    ready.session.prompt('/compact');
    await vi.waitFor(() =>
      expect(ready.harness.requests.some((request) => request.method === 'session/prompt')).toBe(true),
    );
    expect(ctx.entries().some((entry) => entry.entryType === 'error')).toBe(false);
  });
});

describe('the questions the model asks', () => {
  /** A question as the plugin pushes it: a marker line on the harness's
   *  stderr, which is the one stream ACP does not own. */
  const pushed = (callId: string): string =>
    `${QUESTION_MARKER}${JSON.stringify({
      sessionId: 's1',
      callId,
      questions: [{ id: 'q1', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
    })}\n`;

  async function bridge(ready: Harness): Promise<{ requests: Array<Record<string, unknown>>; close: () => void }> {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((connection: Socket) => {
      connection.setEncoding('utf8');
      let buffered = '';
      connection.on('data', (chunk: string) => {
        buffered += chunk;
        const end = buffered.indexOf('\n');
        if (end < 0) return;
        const request = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>;
        requests.push(request);
        connection.write(`${JSON.stringify({ id: request.id, ok: true })}\n`);
      });
      connection.on('error', () => {});
    });
    const socket = bridgeSocketPath(ready.home);
    mkdirSync(path.dirname(socket), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    return { requests, close: () => server.close() };
  }

  it('shows it on the phone and answers the harness with what it chose', async () => {
    const ready = withDriver();
    const socket = await bridge(ready);
    const ctx = recordingContext({
      question: (requestId, questions) => {
        expect(requestId).toBe('c9');
        expect(questions).toEqual([
          { question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
        ]);
        return { outcome: 'answered', answers: ['SQLite'] };
      },
    });
    await started(ready, {}, ctx);
    ready.harness.child.stderr.write(pushed('c9'));
    await vi.waitFor(() => expect(socket.requests.some((request) => request.method === 'answer')).toBe(true));
    expect(socket.requests.find((request) => request.method === 'answer')).toMatchObject({
      sessionId: 's1',
      callId: 'c9',
      answer: [{ id: 'q1', selected: ['SQLite'] }],
    });
    socket.close();
  });

  it('answers with nothing when the user does not, so the model is told', async () => {
    const ready = withDriver();
    const socket = await bridge(ready);
    const ctx = recordingContext({ question: () => ({ outcome: 'cancelled', reason: 'the phone went away' }) });
    await started(ready, {}, ctx);
    ready.harness.child.stderr.write(pushed('c9'));
    await vi.waitFor(() => expect(socket.requests.some((request) => request.method === 'answer')).toBe(true));
    const answer = socket.requests.find((request) => request.method === 'answer')!;
    expect(answer).toMatchObject({ sessionId: 's1', callId: 'c9' });
    expect(answer.answer).toBeUndefined();
    socket.close();
  });

  /** A plan review as the plugin pushes it: `exit_plan_mode` asks through the
   *  same service as the question tool, with the plan as one question's
   *  detail and the verdicts as its options. */
  const pushedPlan = (callId: string): string =>
    `${QUESTION_MARKER}${JSON.stringify({
      sessionId: 's1',
      callId,
      questions: [
        {
          id: 'plan-review',
          header: 'Plan review',
          question: 'Approve this plan and leave plan mode?',
          detail: '# Ship the harness\n\nDo the thing.',
          options: [{ label: 'Approve', description: 'Leave plan mode.' }, { label: 'Keep planning' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        },
      ],
    })}\n`;

  it('shows a plan review as the plan plus an approval, and sends the verdict', async () => {
    const ready = withDriver();
    const socket = await bridge(ready);
    const ctx = recordingContext({
      plan: (requestId, options) => {
        expect(requestId).toBe('c9');
        // The harness's own labels are the choices: they are what the tool
        // reads its verdict from.
        expect(options).toEqual([
          { id: 'Approve', label: 'Approve', description: 'Leave plan mode.' },
          { id: 'Keep planning', label: 'Keep planning' },
        ]);
        return { outcome: 'selected', optionId: 'Approve' };
      },
    });
    await started(ready, {}, ctx);
    ready.harness.child.stderr.write(pushedPlan('c9'));
    await vi.waitFor(() => expect(socket.requests.some((request) => request.method === 'answer')).toBe(true));
    // The plan is a plan of its own, the way Claude Code's plan review shows
    // it — not a question card with a plan in its body.
    expect(ctx.entries().some((entry) => entry.entryType === 'plan' && entry.text === '# Ship the harness\n\nDo the thing.')).toBe(true);
    expect(ctx.questions).toEqual([]);
    expect(socket.requests.find((request) => request.method === 'answer')).toMatchObject({
      sessionId: 's1',
      callId: 'c9',
      answer: [{ id: 'plan-review', selected: ['Approve'] }],
    });
    socket.close();
  });

  it('leaves a plan the user did not approve unanswered, so the tool says so', async () => {
    const ready = withDriver();
    const socket = await bridge(ready);
    const ctx = recordingContext({ plan: () => ({ outcome: 'cancelled', reason: 'the phone went away' }) });
    await started(ready, {}, ctx);
    ready.harness.child.stderr.write(pushedPlan('c9'));
    await vi.waitFor(() => expect(socket.requests.some((request) => request.method === 'answer')).toBe(true));
    const answer = socket.requests.find((request) => request.method === 'answer')!;
    expect(answer.answer).toBeUndefined();
    socket.close();
  });

  it('keeps a pushed question out of the harness log', async () => {
    const ready = withDriver();
    const socket = await bridge(ready);
    const ctx = recordingContext({ question: () => ({ outcome: 'cancelled', reason: 'never mind' }) });
    await started(ready, {}, ctx);
    ready.harness.child.stderr.write(pushed('c9'));
    await vi.waitFor(() => expect(socket.requests.length).toBeGreaterThan(0));
    expect(ready.logs.some((line) => line.includes(QUESTION_MARKER))).toBe(false);
    socket.close();
  });
});

describe('the harness process', () => {
  it('spawns the installed CLI with the profile and the harness home', async () => {
    const ready = withDriver();
    await started(ready);
    expect(ready.spawns[0]?.args).toEqual(['/fake/dsh/lib/bin.js', '--profile', 'acp']);
    expect(ready.spawns[0]?.env.DSH_HOME).toBe(ready.home);
  });

  it('runs an operator-provided entry point instead of installing one', async () => {
    const home = harnessHome();
    const dshPath = path.join(home, 'my-dsh.js');
    writeFileSync(dshPath, '// a standalone harness CLI\n');
    const ready = withDriver({ dshPath });
    await started(ready);
    expect(ready.spawns[0]?.args).toEqual([dshPath, '--profile', 'acp']);
  });

  it('refuses a path that is not a file', async () => {
    const ready = withDriver({ dshPath: path.join(harnessHome(), 'missing.js') });
    const ctx = recordingContext();
    ready.driver.startSession(start(), ctx);
    expect((await ctx.ended()).error).toMatch(/which is not a file/);
  });
});

describe('dshHomeDir', () => {
  it('prefers the operator override and otherwise follows the agent cache', () => {
    expect(dshHomeDir({ CODEDECK_DEEPSEEK_HOME: '/srv/dsh' } as NodeJS.ProcessEnv)).toBe('/srv/dsh');
    expect(dshHomeDir({ CODEDECK_AGENT_CACHE: path.join('/srv/home', 'agents') } as NodeJS.ProcessEnv)).toBe(
      path.join('/srv/home', 'dsh'),
    );
  });
});
