/**
 * The Pi driver over a scripted RPC process (fakePi.ts): the session
 * lifecycle, the permission policy, dialogs, interruption and resume.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordingContext, type RecordingContext } from '../../../sdk/__tests__/context';
import type { DriverSession } from '../../../sdk/driver';
import type { SelectOutcome, StartSession } from '../../../sdk/types';
import { PiDriver } from '../driver';
import { PI_PERMISSION_PREFIX } from '../extension';
import { PiRuntime } from '../runtime';
import { PI_READ_ONLY_TOOLS } from '../tools';
import { FakePi, type FakePiOptions } from './fakePi';

interface Harness {
  driver: PiDriver;
  fake: FakePi;
  home: string;
  spawns: Array<{ command: string; args: string[]; env: Record<string, string>; cwd: string; stdio: string[] }>;
  logs: string[];
  session?: DriverSession;
}

function withDriver(options: { fake?: FakePiOptions; killTree?: (pid: number) => void } = {}): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-'));
  const home = path.join(root, 'home');
  const cli = path.join(root, 'pi.js');
  writeFileSync(cli, '// a scripted Pi: the spawn seam answers instead\n');
  const fake = new FakePi({ model: { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }, ...options.fake });
  const spawns: Harness['spawns'] = [];
  const logs: string[] = [];
  const runtime = new PiRuntime({
    piPath: cli,
    cacheDir: path.join(root, 'agents'),
    installPi: async () => cli,
    log: (line) => logs.push(line),
  });
  const driver = new PiDriver({
    runtime,
    home,
    baseEnv: {},
    spawnFn: ((command: string, args: string[], opts: { env: Record<string, string>; cwd: string; stdio: string[] }) => {
      spawns.push({ command, args, env: opts.env, cwd: opts.cwd, stdio: opts.stdio });
      return fake.child;
    }) as never,
    ...(options.killTree ? { killTree: options.killTree } : {}),
    log: (line) => logs.push(line),
  });
  return { driver, fake, home, spawns, logs };
}

function start(h: Harness, overrides: Partial<StartSession> = {}, ctx: RecordingContext = recordingContext()): RecordingContext {
  h.session = h.driver.startSession({ sessionId: 'b1', agent: 'pi', cwd: '/work', ...overrides }, ctx);
  return ctx;
}

async function ready(h: Harness, overrides: Partial<StartSession> = {}, ctx: RecordingContext = recordingContext()): Promise<RecordingContext> {
  start(h, overrides, ctx);
  await ctx.waitFor((event) => event.type === 'ready');
  return ctx;
}

async function turn(session: DriverSession, ctx: RecordingContext, text: string): Promise<void> {
  // The event's own position, not just its shape: an earlier turn's idle is
  // already in the recording and would otherwise end this wait at once.
  const start = ctx.events.length;
  const idle = ctx.waitFor(
    (event) => ctx.events.indexOf(event) >= start && event.type === 'turn' && event.state === 'idle',
  );
  session.prompt(text);
  await idle;
}

const entries = (ctx: RecordingContext) => ctx.entries();

describe('PiDriver.info', () => {
  it('advertises the modes, efforts and capabilities the RPC surface has', () => {
    const { driver } = withDriver();
    const info = driver.info();
    expect(info.id).toBe('pi');
    expect(info.displayName).toBe('Pi');
    expect(info.modes?.map((mode) => mode.id)).toEqual(['ask', 'auto-edit', 'plan', 'yolo']);
    expect(info.efforts?.map((effort) => effort.id)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(info.defaultMode).toBe('ask');
    expect(info.defaultEffort).toBe('medium');
    expect(info.supports).toEqual({
      models: true,
      usage: false,
      providers: true,
      interrupt: true,
      commands: true,
      accounts: true,
      plugins: true,
      mcp: true,
      tasks: true,
    });
    // Pi's own auth in its home applies; there is no CodeDeck credential.
    expect(info.credentials).toEqual([]);
  });

  it('lists the read-only tools Pi runs without a card', () => {
    expect([...PI_READ_ONLY_TOOLS].sort()).toEqual(['find', 'grep', 'ls', 'read']);
  });
});

describe('PiSession startup', () => {
  it('spawns the pinned CLI in RPC mode with the session home and the extension', async () => {
    const h = withDriver();
    const ctx = await ready(h, { model: 'claude-sonnet-5' });

    expect(h.spawns).toHaveLength(1);
    const spawn = h.spawns[0]!;
    expect(spawn.command).toMatch(/node/i);
    // The CLI's path is the first argument (the process is the host's node).
    expect(spawn.args.slice(1, 4)).toEqual(['--mode', 'rpc', '--offline']);
    const extension = spawn.args[spawn.args.indexOf('-e') + 1]!;
    expect(extension.endsWith(path.join('codedeck', 'codedeck-pi.js'))).toBe(true);
    // Added to Pi's defaults, never in place of them (`+name` entries).
    const tools = spawn.args[spawn.args.indexOf('--tools') + 1]!;
    expect(tools.split(',')).toContain('+ls');
    expect(tools.split(',').every((entry) => entry.startsWith('+'))).toBe(true);
    expect(spawn.args).toContain('--model');
    expect(spawn.args[spawn.args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
    expect(spawn.env.PI_CODING_AGENT_DIR).toBe(h.home);
    expect(spawn.env.PI_SKIP_VERSION_CHECK).toBe('1');
    expect(spawn.env.PI_TELEMETRY).toBe('0');
    expect(spawn.cwd).toBe('/work');

    expect(ctx.events).toContainEqual(
      expect.objectContaining({ type: 'info', nativeSessionId: 'pi-session-1', model: 'Claude Sonnet 5', mode: 'ask' }),
    );
  });

  it('resumes by passing --session with the Pi conversation id', async () => {
    const h = withDriver();
    await ready(h, { resume: 'pi-session-1' });
    const args = h.spawns[0]!.args;
    expect(args[args.indexOf('--session') + 1]).toBe('pi-session-1');
  });

  it('reports a resume Pi cannot find as resumeLost, with Pi’s own line', async () => {
    const h = withDriver({
      fake: { exitOnStart: { code: 1, stderr: "No session found matching 'gone'" } },
    });
    const ctx = start(h, { resume: 'gone' });
    const ended = await ctx.ended();
    expect(ended).toMatchObject({ resumeLost: true, error: expect.stringContaining('No session found') });
  });

  it('keeps a resumed conversation when Pi fails to start for any other reason', async () => {
    // resumeLost makes the bridge forget the conversation and start afresh:
    // a crash or a bad flag must not cost the user their history.
    const h = withDriver({ fake: { exitOnStart: { code: 1, stderr: 'Error: unknown option --bogus' } } });
    const ctx = start(h, { resume: 'pi-session-1' });
    const ended = await ctx.ended();
    expect(ended).toMatchObject({ error: expect.stringContaining('unknown option') });
    expect(ended).not.toHaveProperty('resumeLost');
  });

  it('keeps a resumed conversation when the runtime cannot be installed', async () => {
    const h = withDriver();
    const failing = new PiDriver({
      runtime: new PiRuntime({
        cacheDir: path.join(h.home, 'agents'),
        installPi: async () => {
          throw new Error('registry unreachable');
        },
        log: () => {},
      }),
      home: h.home,
      baseEnv: {},
      log: () => {},
    });
    const ctx = recordingContext();
    failing.startSession({ sessionId: 'b1', agent: 'pi', cwd: '/work', resume: 'pi-session-1' }, ctx);
    const ended = await ctx.ended();
    expect(ended).toMatchObject({ error: expect.stringContaining('registry unreachable') });
    expect(ended).not.toHaveProperty('resumeLost');
  });

  it("binds a provider profile through the environment, and hands its token over on Pi's token pipe only", async () => {
    const h = withDriver();
    await ready(h, {
      model: 'fake-model-1',
      provider: {
        id: 'codedeck-fake',
        label: 'Fake',
        baseUrl: 'https://api.example.com',
        authToken: 'sk-secret',
        models: [{ id: 'fake-model-1', label: 'Fake model' }],
      },
    });
    const spawn = h.spawns[0]!;
    expect(spawn.args[spawn.args.indexOf('--model') + 1]).toBe('codedeck-fake/fake-model-1');
    const profile = JSON.parse(spawn.env.CODEDECK_PI_PROVIDER!) as Record<string, unknown>;
    expect(profile).toMatchObject({ id: 'codedeck-fake', label: 'Fake', baseUrl: 'https://api.example.com/v1' });
    // Nowhere in the environment, under any name: everything Pi starts
    // inherits it.
    expect(JSON.stringify(spawn.env)).not.toContain('sk-secret');
    expect(spawn.stdio).toHaveLength(4);
    expect(h.fake.token).toBe('sk-secret');
    expect(h.fake.tokenClosed).toBe(true);
  });

  it('opens no token pipe for a session without a profile', async () => {
    const h = withDriver();
    await ready(h);
    expect(h.spawns[0]!.stdio).toHaveLength(3);
    expect(h.fake.token).toBe('');
  });

  describe('a profile token quoted back by a failure', () => {
    const TOKEN = 'sk-codedeck-profile-secret-0123456789';
    // Any piece of it long enough to be worth anything.
    const PIECE = TOKEN.slice(0, 16);
    const provider = {
      id: 'codedeck-fake',
      label: 'Fake',
      baseUrl: 'https://api.example.com',
      authToken: TOKEN,
      models: [{ id: 'fake-model-1', label: 'Fake model' }],
    };

    it('is not in the errors and retries the phone is shown', async () => {
      const h = withDriver();
      const ctx = await ready(h, { model: 'fake-model-1', provider });
      // An endpoint that echoes the header it refused, the token straddling
      // the point where a retry line is cut short (it starts at column 100).
      await turn(h.session!, ctx, `/give-up 401 Unauthorized: ${'x'.repeat(59)} Authorization: Bearer ${TOKEN}`);
      await turn(h.session!, ctx, `/bad-request invalid api key ${TOKEN}`);
      const shown = JSON.stringify(entries(ctx));
      expect(shown).toContain('401 Unauthorized');
      expect(shown).toContain('invalid api key');
      expect(shown).not.toContain(PIECE);
    });

    it('is not in what Pi printed, in the log or in the reason the session ended', async () => {
      const h = withDriver({ fake: { exitOnStart: { code: 1, stderr: `Error: the endpoint refused ${TOKEN}` } } });
      const ctx = start(h, { model: 'fake-model-1', provider });
      const ended = await ctx.ended();
      expect(ended).toMatchObject({ error: expect.stringContaining('the endpoint refused') });
      expect(JSON.stringify(ended)).not.toContain(PIECE);
      expect(h.logs.join('\n')).toContain('the endpoint refused');
      expect(h.logs.join('\n')).not.toContain(PIECE);
    });

    it('is not in the log when an extension fails or Pi prints a line that is not a record', async () => {
      const h = withDriver();
      await ready(h, { model: 'fake-model-1', provider });
      h.fake.emit({ type: 'extension_error', error: `registerProvider refused apiKey ${TOKEN}` });
      // A line that starts with it: a parse error quotes the line's start,
      // cut where the redaction could no longer find it.
      h.fake.print(`${TOKEN} was not accepted`);
      h.fake.emit({ type: 'response', success: false, error: `bad command near ${TOKEN}` });
      const logged = h.logs.join('\n');
      expect(logged).toContain('an extension failed');
      expect(logged).toContain('dropped a line');
      expect(logged).not.toContain(PIECE);
      expect(logged).not.toContain(TOKEN.slice(0, 8));
    });
  });

  it('refuses a provider profile with an insecure endpoint before it starts', () => {
    const h = withDriver();
    expect(() =>
      start(h, {
        provider: {
          id: 'insecure',
          label: 'Insecure',
          baseUrl: 'http://example.com',
          authToken: 'sk',
          models: [{ id: 'm' }],
        },
      }),
    ).toThrow(/insecure base URL/);
    expect(h.spawns).toHaveLength(0);
  });
});

describe('PiSession turns', () => {
  it('streams the reply and reports it as one agent text entry', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    await turn(h.session!, ctx, 'hello');

    expect(entries(ctx)).toContainEqual(
      expect.objectContaining({ entryType: 'text', role: 'agent', text: 'echo: hello' }),
    );
    expect(entries(ctx)).toContainEqual(expect.objectContaining({ entryType: 'turn_complete' }));
    expect(ctx.events).toContainEqual({ type: 'turn', state: 'running' });
    expect(ctx.events).toContainEqual({ type: 'turn', state: 'idle' });
    expect(h.fake.commands.find((c) => c.type === 'prompt')).toMatchObject({ message: 'hello' });
    // The context meter Pi reports reaches the phone as session info.
    await ctx.waitFor((event) => event.type === 'info' && event.contextPercentage !== undefined);
  });

  it('shows a request Pi retried and recovered as retries, not errors', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    await turn(h.session!, ctx, '/retry');
    const shown = entries(ctx);
    expect(shown.filter((entry) => entry.entryType === 'error')).toEqual([]);
    expect(shown.filter((entry) => entry.entryType === 'status').map((entry) => entry.entryType === 'status' && entry.text)).toEqual([
      expect.stringMatching(/^Retrying in 2s \(1 of 3\): 429/),
      expect.stringMatching(/^Retrying in 4s \(2 of 3\): 429/),
    ]);
    expect(shown).toContainEqual(expect.objectContaining({ entryType: 'text', role: 'agent', text: 'recovered' }));
  });

  it('shows one error when Pi gives up retrying', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    await turn(h.session!, ctx, '/give-up');
    const errors = entries(ctx).filter((entry) => entry.entryType === 'error');
    expect(errors).toEqual([expect.objectContaining({ text: expect.stringContaining('rate limited (scripted)') })]);
  });

  it('keeps a retry line to the first line of a long provider error', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    await turn(h.session!, ctx, '/retry');
    const lines = entries(ctx).flatMap((entry) => (entry.entryType === 'status' ? [entry.text] : []));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeLessThan(170);
  });

  it('shows no error when the user stops a turn waiting to retry', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    const idle = ctx.waitFor((event) => event.type === 'turn' && event.state === 'idle');
    h.session!.prompt('/retry-wait');
    await ctx.waitFor((event) => event.type === 'entries' && event.entries.some((entry) => entry.entryType === 'status'));
    await h.session!.interrupt();
    await idle;
    expect(entries(ctx).filter((entry) => entry.entryType === 'error')).toEqual([]);
  });

  it('shows an error Pi does not retry once the run settles', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    await turn(h.session!, ctx, '/bad-request');
    expect(entries(ctx).filter((entry) => entry.entryType === 'error')).toEqual([
      expect.objectContaining({ text: '400: invalid request' }),
    ]);
  });

  it('steers a message sent while a turn runs', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    // A turn is running once `prompt` started; the first settled event ends
    // it, so the steer is written before that.
    h.session!.prompt('hello');
    h.session!.prompt('change of plan');
    await ctx.waitFor((event) => event.type === 'turn' && event.state === 'idle');
    expect(h.fake.commands.find((c) => c.type === 'steer')).toMatchObject({ message: 'change of plan' });
  });
});

describe('PiSession permission policy', () => {
  it('asks in ask mode, and Deny blocks the call with Pi’s reason', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    await turn(h.session!, ctx, '/tool');

    expect(ctx.permissions).toHaveLength(1);
    expect(ctx.permissions[0]).toMatchObject({ toolName: 'bash', kind: 'execute', title: 'echo codedeck > file.txt' });
    expect(ctx.permissions[0]!.options.map((option) => option.id)).toEqual(['allow', 'allow_session', 'deny']);
    expect(h.fake.uiResponses.at(-1)).toMatchObject({ value: 'deny' });
    expect(entries(ctx)).toContainEqual(
      expect.objectContaining({ entryType: 'tool_result', isError: true, text: expect.stringContaining('Denied by the user') }),
    );
  });

  it('answers Allow and the tool runs', async () => {
    const h = withDriver();
    const ctx = await ready(h, {}, recordingContext({ permission: () => ({ outcome: 'selected', optionId: 'allow' }) }));
    await turn(h.session!, ctx, '/tool');

    expect(h.fake.uiResponses.at(-1)).toMatchObject({ value: 'allow' });
    expect(entries(ctx)).toContainEqual(expect.objectContaining({ entryType: 'tool_call', toolName: 'bash', kind: 'execute' }));
    expect(entries(ctx)).toContainEqual(
      expect.objectContaining({ entryType: 'tool_result', text: 'ran it' }),
    );
  });

  it('answers everything in yolo mode without a card', async () => {
    const h = withDriver();
    const ctx = await ready(h, { mode: 'yolo' });
    await turn(h.session!, ctx, '/tool');

    expect(ctx.permissions).toHaveLength(0);
    expect(h.fake.uiResponses.at(-1)).toMatchObject({ value: 'allow' });
  });

  it('lets Pi’s read-only tools run without a card in ask mode', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    await turn(h.session!, ctx, '/read');

    expect(ctx.permissions).toHaveLength(0);
    expect(h.fake.uiResponses.at(-1)).toMatchObject({ value: 'allow' });
    expect(entries(ctx)).toContainEqual(expect.objectContaining({ entryType: 'tool_call', toolName: 'read', kind: 'read' }));
  });

  it('runs Pi’s file edits without a card in auto-edit mode, and still asks before a command', async () => {
    const h = withDriver();
    const ctx = await ready(h, { mode: 'auto-edit' });
    await turn(h.session!, ctx, '/edit');
    expect(ctx.permissions).toHaveLength(0);
    expect(h.fake.uiResponses.at(-1)).toMatchObject({ value: 'allow' });

    await turn(h.session!, ctx, '/tool');
    expect(ctx.permissions).toHaveLength(1);
    expect(ctx.permissions[0]).toMatchObject({ toolName: 'bash' });
  });

  it('asks before a file edit in ask mode', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    await turn(h.session!, ctx, '/edit');
    expect(ctx.permissions).toHaveLength(1);
    expect(ctx.permissions[0]).toMatchObject({ toolName: 'edit', kind: 'edit' });
  });

  it('remembers “allow for this session” for that tool only', async () => {
    const h = withDriver();
    const ctx = await ready(
      h,
      {},
      recordingContext({ permission: () => ({ outcome: 'selected', optionId: 'allow_session' }) }),
    );
    await turn(h.session!, ctx, '/tool');
    await turn(h.session!, ctx, '/tool');

    expect(ctx.permissions).toHaveLength(1);
    expect(h.fake.uiResponses.filter((response) => response.value === 'allow')).toHaveLength(2);
  });

  it('answers a dialog cancelled when the turn is interrupted, so Pi settles', async () => {
    let release!: (outcome: SelectOutcome) => void;
    const h = withDriver();
    const ctx = await ready(h, {}, recordingContext({ permission: () => new Promise((resolve) => (release = resolve)) }));

    h.session!.prompt('/tool');
    await ctx.waitFor((event) => event.type === 'entries' && event.entries.some((entry) => entry.entryType === 'tool_call'));
    await h.session!.interrupt();
    release({ outcome: 'cancelled', reason: 'interrupted' });
    await ctx.waitFor((event) => event.type === 'turn' && event.state === 'idle');

    expect(h.fake.uiResponses.at(-1)).toMatchObject({ cancelled: true });
    expect(h.fake.commands.some((command) => command.type === 'abort')).toBe(true);
  });
});

describe('PiSession commands and options', () => {
  it('lists the commands Pi reports', async () => {
    const h = withDriver();
    await ready(h);
    expect(await h.session!.listCommands!()).toEqual([{ name: 'fix-tests', description: 'Fix failing tests' }]);
  });

  it('shows the MCP servers the session’s Pi loaded, and one added since as not loaded yet', async () => {
    const h = withDriver();
    await h.driver.mcp.act('add', [{ name: 'first', setup: { type: 'stdio', command: 'node' } }], []);
    await ready(h);
    expect((await h.session!.mcpStatus!()).servers).toEqual([{ name: 'first', status: 'connected' }]);
    await h.driver.mcp.act('add', [{ name: 'second', setup: { type: 'stdio', command: 'node' } }], []);
    await h.driver.mcp.act('disable', [], ['first']);
    expect((await h.session!.mcpStatus!()).servers).toEqual([
      { name: 'first', status: 'disabled' },
      { name: 'second', status: 'pending' },
    ]);
  });

  it('applies a thinking level through Pi’s own command', async () => {
    const h = withDriver();
    await ready(h);
    await h.session!.setOption('effort', 'high');
    expect(h.fake.commands.find((command) => command.type === 'set_thinking_level')).toMatchObject({ level: 'high' });
  });

  it('applies a thinking level chosen while Pi is still starting, once it is ready', async () => {
    // The process starts asynchronously (the runtime is resolved first), so
    // right after startSession there is no Pi to send the command to yet.
    const h = withDriver();
    const ctx = start(h);
    const applied = h.session!.setOption('effort', 'low');
    await ctx.waitFor((event) => event.type === 'ready');
    await applied;
    expect(h.fake.commands.find((command) => command.type === 'set_thinking_level')).toMatchObject({ level: 'low' });
  });

  it('refuses an option for a session that ended before Pi was ready', async () => {
    const h = withDriver();
    start(h);
    const applied = h.session!.setOption('effort', 'low');
    await h.session!.end();
    await expect(applied).rejects.toThrow(/ended/);
  });

  it('switches models through set_model, naming the profile for a bound session', async () => {
    const h = withDriver();
    await ready(h, {
      provider: {
        id: 'codedeck-fake',
        label: 'Fake',
        baseUrl: 'https://api.example.com/v1',
        authToken: 'sk',
        models: [{ id: 'fake-model-1' }],
      },
    });
    await h.session!.setOption('model', 'fake-model-1');
    expect(h.fake.commands.find((command) => command.type === 'set_model')).toMatchObject({
      provider: 'codedeck-fake',
      modelId: 'fake-model-1',
    });
  });

  it('refuses a mode or effort Pi does not have', async () => {
    const h = withDriver();
    await ready(h);
    await expect(h.session!.setOption('mode', 'bypass')).rejects.toThrow(/no mode 'bypass'/);
    await expect(h.session!.setOption('effort', 'turbo')).rejects.toThrow(/no thinking level 'turbo'/);
  });
});

describe('PiDriver models and conversations', () => {
  it('lists the model catalog of a probe process, with unique ids', async () => {
    const h = withDriver();
    const listed = await h.driver.listModels();
    expect(listed.models).toEqual([
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' },
    ]);
    expect(listed.defaultModel).toBe('anthropic/claude-sonnet-5');
  });

  it('deletes the session file Pi filed under its project directory', async () => {
    const h = withDriver();
    const project = path.join(h.home, 'sessions', '--work--');
    mkdirSync(project, { recursive: true });
    const file = path.join(project, '2026-01-01T00-00-00-000Z_abc.jsonl');
    writeFileSync(file, '{}\n');
    await h.driver.deleteConversation('abc', '/work');
    expect(existsSync(file)).toBe(false);
  });

  it('refuses to delete a path that is not a session id', async () => {
    const h = withDriver();
    await expect(h.driver.deleteConversation('../state', '/work')).rejects.toThrow(/not a Pi session id/);
  });
});

describe('PiSession background tasks', () => {
  const task = (data: Record<string, unknown>) => ({
    type: 'entry_appended',
    entry: { type: 'custom', id: 'e1', customType: 'codedeck', data: { kind: 'task', taskId: 'bg-1', title: 'Dev server', ...data } },
  });

  it('kills a task the phone stops, and shows it stopped however its shell exits', async () => {
    const killed: number[] = [];
    const h = withDriver({ killTree: (pid) => killed.push(pid) });
    const ctx = await ready(h);
    h.fake.emit(task({ status: 'running', pid: 4321, callId: 'call_b' }));
    await ctx.waitFor((e) => e.type === 'entries' && e.entries.some((entry) => entry.entryType === 'background_task'));

    await h.session!.stopTask!('bg-1');
    expect(killed).toEqual([4321]);
    // A shell that traps the stop may still exit 0.
    h.fake.emit(task({ status: 'completed', summary: 'Exited with code 0' }));
    await ctx.waitFor((e) => e.type === 'entries' && e.entries.some((entry) => entry.entryType === 'background_task' && entry.status !== 'running'));
    expect(entries(ctx).filter((entry) => entry.entryType === 'background_task').at(-1)).toMatchObject({
      status: 'stopped',
      summary: 'Stopped',
    });
    await expect(h.session!.stopTask!('bg-1')).rejects.toThrow(/no running task/);
  });
});

describe('PiSession file changes', () => {
  const end = (toolCallId: string, toolName: string, details: unknown, isError = false) => ({
    type: 'tool_execution_end',
    toolCallId,
    toolName,
    result: { content: [{ type: 'text', text: isError ? 'Could not find the text' : 'Done' }], details },
    isError,
  });
  const diffs = (ctx: Parameters<typeof entries>[0]) => entries(ctx).filter((entry) => entry.entryType === 'diff');

  it('shows an edit as the diff of the patch Pi applied, context lines included', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    h.fake.emit({ type: 'tool_execution_start', toolCallId: 'call_e', toolName: 'edit', args: { path: 'src/a.ts', edits: [{ oldText: 'b', newText: 'c' }] } });
    // The shape Pi's edit-diff.js formats: file headers, then one hunk.
    const patch = '--- src/a.ts\n+++ src/a.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n';
    h.fake.emit(end('call_e', 'edit', { diff: '…', patch, firstChangedLine: 2 }));
    await ctx.waitFor((event) => event.type === 'entries' && event.entries.some((entry) => entry.entryType === 'diff'));
    expect(diffs(ctx)).toEqual([
      expect.objectContaining({
        path: 'src/a.ts',
        callId: 'call_e',
        lines: [
          { type: 'context', text: 'a' },
          { type: 'del', text: 'b' },
          { type: 'add', text: 'c' },
          { type: 'context', text: 'd' },
        ],
      }),
    ]);
  });

  it('shows a write as its content added, and no card for a change that failed', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    h.fake.emit({ type: 'tool_execution_start', toolCallId: 'call_w', toolName: 'write', args: { path: 'b.py', content: 'x = 1\ny = 2' } });
    h.fake.emit(end('call_w', 'write', undefined));
    h.fake.emit({ type: 'tool_execution_start', toolCallId: 'call_f', toolName: 'edit', args: { path: 'c.rs', edits: [] } });
    h.fake.emit(end('call_f', 'edit', undefined, true));
    await ctx.waitFor((event) => event.type === 'entries' && event.entries.some((entry) => entry.entryType === 'tool_result' && entry.callId === 'call_f'));
    expect(diffs(ctx)).toEqual([
      expect.objectContaining({ path: 'b.py', callId: 'call_w', lines: [{ type: 'add', text: 'x = 1' }, { type: 'add', text: 'y = 2' }] }),
    ]);
  });

  it("shows a sub-agent's edit under its parent's call", async () => {
    const h = withDriver();
    const ctx = await ready(h);
    const subagent = { label: 'general', parentCallId: 'call_task' };
    const update = (seq: number, event: Record<string, unknown>) => ({
      type: 'tool_execution_update',
      toolCallId: 'call_task',
      toolName: 'task',
      partialResult: { content: [], details: { subagent, seq, event } },
    });
    h.fake.emit({ type: 'tool_execution_start', toolCallId: 'call_task', toolName: 'task', args: { description: 'x', prompt: 'y', agent: 'general' } });
    h.fake.emit(update(1, { kind: 'tool_call', callId: 'c1', toolName: 'edit', args: { path: 'a.ts', edits: [] } }));
    h.fake.emit(update(2, { kind: 'tool_result', callId: 'c1', text: 'Done', isError: false, patch: '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-x\n+y\n' }));
    await ctx.waitFor((event) => event.type === 'entries' && event.entries.some((entry) => entry.entryType === 'diff'));
    expect(diffs(ctx)).toEqual([
      expect.objectContaining({ path: 'a.ts', callId: 'call_task/c1', subagent, lines: [{ type: 'del', text: 'x' }, { type: 'add', text: 'y' }] }),
    ]);
  });
});

describe('PiSession checklist', () => {
  it('shows a todo call as the checklist, not as a tool row', async () => {
    const h = withDriver();
    const ctx = await ready(h);
    const todos = [
      { content: 'Read the code', status: 'completed' },
      { content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' },
      { content: '', status: 'pending' },
      { content: 'Ship it', status: 'later' },
    ];
    h.fake.emit({ type: 'tool_execution_start', toolCallId: 'call_t', toolName: 'todo', args: { todos } });
    h.fake.emit({
      type: 'tool_execution_end',
      toolCallId: 'call_t',
      toolName: 'todo',
      result: { content: [{ type: 'text', text: 'Checklist updated' }] },
      isError: false,
    });
    await ctx.waitFor((event) => event.type === 'entries' && event.entries.some((entry) => entry.entryType === 'todos'));

    expect(entries(ctx)).toContainEqual(
      expect.objectContaining({
        entryType: 'todos',
        callId: 'call_t',
        items: [
          { text: 'Read the code', status: 'completed' },
          { text: 'Run the tests', status: 'in_progress', activeText: 'Running the tests' },
          // A blank item is dropped; an unknown status reads as pending.
          { text: 'Ship it', status: 'pending' },
        ],
      }),
    );
    expect(entries(ctx).some((entry) => entry.entryType === 'tool_call' || entry.entryType === 'tool_result')).toBe(false);
  });
});
