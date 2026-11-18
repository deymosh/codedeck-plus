/**
 * The real Pi CLI against the local model server (tools/fake-model.mjs) —
 * one session, its provider profile bound the way the bridge binds one, and
 * the permission gate exercised both ways.
 *
 * What this covers that the scripted RPC tests cannot: Pi's own startup with
 * the extension CodeDeck writes, the provider registration reaching Pi's model
 * selector, the tool call the fake model scripts, and the hold-and-answer of
 * Pi's extension UI dialog. Nothing leaves the machine and nothing is spent:
 * the model server answers every request.
 *
 * The CLI is the package this build pins as a devDependency, so the test runs
 * wherever the workspace is installed (CI included) and skips, saying so,
 * where it is not. The model server runs as its own process, since a driver
 * test may not import outside its folder.
 *
 * Timing: each test starts Pi and runs one turn, so the timeouts are generous
 * on purpose — a slow runner must not read as a failure.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PiDriver } from '../driver';
import { bundledPiExecutable } from '../install';
import { PiRuntime } from '../runtime';
import { recordingContext, type Handlers, type RecordingContext } from '../../../sdk/__tests__/context';
import type { DriverSession } from '../../../sdk/driver';
import type { StartSession } from '../../../sdk/types';

/** The local model server and the one model it answers as (both named here:
 *  this file may not import from outside its folder). */
const MODEL_SERVER = fileURLToPath(new URL('../../../../tools/fake-model.mjs', import.meta.url));
const FAKE_MODEL_ID = 'fake-model-1';
/** The agent host's node_modules: TypeScript 5 and typescript-language-server. */
const HOST_NODE_MODULES = fileURLToPath(new URL('../../../../node_modules', import.meta.url));

interface FakeModelServer {
  url: string;
  stop(): Promise<void>;
}

function startFakeModel(timeoutMs = 15_000): Promise<FakeModelServer> {
  const child = spawn(process.execPath, [MODEL_SERVER, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      void stopServer(child);
      reject(new Error(`the fake model did not start: ${output}`));
    }, timeoutMs);
    const onOutput = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve({ url: match[1]!, stop: () => stopServer(child) });
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the fake model exited (${code}): ${output}`));
    });
  });
}

function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 3_000);
    child.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

const piPath = bundledPiExecutable();
if (!piPath) {
  // Said once, at collection: a skip with no reason reads like a broken test.
  console.warn('piFakeModel: no Pi CLI beside the workspace — skipping the live fake-model tests');
}
const live = piPath ? describe : describe.skip;

/** How long a turn may take: process start, extension load and one request to
 *  a loopback server. */
const TURN_MS = 90_000;

live('Pi against the fake model', () => {
  let model: FakeModelServer | undefined;
  let modelUrl = '';
  let home = '';
  let cwd = '';
  let session: DriverSession | undefined;

  beforeEach(async () => {
    model = await startFakeModel();
    modelUrl = model.url;
    home = await mkdtemp(path.join(tmpdir(), 'codedeck-pi-home-'));
    cwd = await mkdtemp(path.join(tmpdir(), 'codedeck-pi-work-'));
  });

  afterEach(async () => {
    await session?.end();
    session = undefined;
    await model?.stop();
    model = undefined;
    // A language server Pi started is stopped as Pi exits, a moment after
    // the session ends; until then Windows keeps its directory locked.
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  /** A session bound to the local server the way the bridge binds one to a
   *  provider profile. */
  function start(handlers: Handlers = {}, overrides: Partial<StartSession> = {}): RecordingContext {
    const ctx = recordingContext(handlers);
    const runtime = new PiRuntime({
      piPath: piPath!,
      cacheDir: path.join(home, 'agents'),
      installPi: async () => piPath!,
      log: (line) => ctx.log(line),
    });
    const driver = new PiDriver({ runtime, home, baseEnv: {}, log: (line) => ctx.log(line) });
    session = driver.startSession(
      {
        sessionId: `live-${Date.now()}`,
        agent: 'pi',
        cwd,
        mode: 'ask',
        model: FAKE_MODEL_ID,
        provider: {
          id: 'codedeck-fake',
          label: 'Fake model',
          baseUrl: modelUrl,
          authToken: 'codedeck-fake-model',
          models: [{ id: FAKE_MODEL_ID, label: 'Fake model' }],
          defaultModel: FAKE_MODEL_ID,
        },
        ...overrides,
      },
      ctx,
    );
    return ctx;
  }

  async function turn(ctx: RecordingContext, text: string): Promise<void> {
    await ctx.waitFor((event) => event.type === 'ready', TURN_MS);
    const start = ctx.events.length;
    const idle = ctx.waitFor(
      (event) => ctx.events.indexOf(event) >= start && event.type === 'turn' && event.state === 'idle',
      TURN_MS,
    );
    session!.prompt(text);
    await idle;
  }

  it(
    'raises the permission card for the tool call, and Deny blocks the write',
    async () => {
      const ctx = start({ permission: () => ({ outcome: 'selected', optionId: 'deny' }) });
      await turn(ctx, '/tool');

      expect(ctx.permissions).toHaveLength(1);
      expect(ctx.permissions[0]).toMatchObject({ toolName: 'bash', kind: 'execute' });
      expect(ctx.entries()).toContainEqual(expect.objectContaining({ entryType: 'tool_call', toolName: 'bash' }));
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'tool_result', isError: true, text: expect.stringContaining('Denied by the user') }),
      );
      expect(existsSync(path.join(cwd, 'codedeck-fake-model.txt'))).toBe(false);
    },
    TURN_MS,
  );

  it(
    'lets Allow run the tool, and the answer that follows ends the turn',
    async () => {
      const ctx = start({ permission: () => ({ outcome: 'selected', optionId: 'allow' }) });
      await turn(ctx, '/tool');

      expect(ctx.permissions).toHaveLength(1);
      expect(existsSync(path.join(cwd, 'codedeck-fake-model.txt'))).toBe(true);
      const results = ctx.entries().filter((entry) => entry.entryType === 'tool_result');
      expect(results).not.toHaveLength(0);
      expect(results.every((entry) => entry.entryType !== 'tool_result' || entry.isError !== true)).toBe(true);
      // The fake model answers the tool result with text, which is the last
      // assistant turn the session shows.
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'text', role: 'agent', text: expect.stringContaining('tool-finished') }),
      );
    },
    TURN_MS,
  );

  it(
    'asks through the question card and gives the model the answer, with no tool row',
    async () => {
      const ctx = start({
        question: () => ({ outcome: 'answered', answers: [{ type: 'selected', labels: ['Blue'] }] }),
      });
      await turn(ctx, '/question');

      // No permission card: asking is the card.
      expect(ctx.permissions).toHaveLength(0);
      expect(ctx.questions).toHaveLength(1);
      expect(ctx.questions[0]!.questions[0]).toMatchObject({ question: 'Which color?', header: 'Color' });
      expect(ctx.questions[0]!.questions[0]!.options?.map((option) => option.label)).toContain('Blue');
      expect(ctx.entries().some((entry) => entry.entryType === 'tool_call' && entry.toolName === 'ask')).toBe(false);
      // The fake model echoes the tool result it was sent.
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'text', role: 'agent', text: expect.stringContaining('Blue') }),
      );
    },
    TURN_MS,
  );

  it(
    'in plan mode, refuses a command that writes and presents the plan as a card whose approval switches the mode',
    async () => {
      const ctx = start(
        { plan: () => ({ outcome: 'selected', optionId: 'auto-edit' }) },
        { mode: 'plan' },
      );
      await turn(ctx, '/tool');
      // The write is refused without a card, with the reason that says what to do.
      expect(ctx.permissions).toHaveLength(0);
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'tool_result', isError: true, text: expect.stringContaining('plan mode') }),
      );
      expect(existsSync(path.join(cwd, 'codedeck-fake-model.txt'))).toBe(false);

      await turn(ctx, '/plan-approval');
      expect(ctx.plans).toHaveLength(1);
      expect(ctx.plans[0]!.options.map((option) => option.id)).toEqual(['ask', 'auto-edit', 'revise']);
      expect(ctx.plans[0]!.revise).toBe('revise');
      expect(ctx.entries()).toContainEqual(expect.objectContaining({ entryType: 'plan', text: expect.stringContaining('Do the thing') }));
      expect(ctx.events).toContainEqual(expect.objectContaining({ type: 'info', mode: 'auto-edit' }));
    },
    TURN_MS,
  );

  it(
    "runs a sub-agent whose own command asks through the parent's card, tagged with the sub-agent",
    async () => {
      const ctx = start({ permission: () => ({ outcome: 'selected', optionId: 'allow' }) });
      await turn(ctx, '/task /tool');

      const task = ctx.entries().find((entry) => entry.entryType === 'tool_call' && entry.toolName === 'task');
      expect(task, 'the parent called task').toBeDefined();
      const parentCallId = task!.entryType === 'tool_call' ? task!.callId : '';
      // The task call itself needs no card; the child's command does, and
      // the card says which sub-agent asks.
      expect(ctx.permissions).toHaveLength(1);
      expect(ctx.permissions[0]).toMatchObject({ toolName: 'bash', subagent: { label: 'general', parentCallId } });
      expect(existsSync(path.join(cwd, 'codedeck-fake-model.txt'))).toBe(true);
      // The child's work shows under the parent's call.
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'tool_call', toolName: 'bash', subagent: { label: 'general', parentCallId } }),
      );
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'text', text: expect.stringContaining('tool-finished'), subagent: expect.anything() }),
      );
      // Its answer is the task's result, which the parent's model answers.
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'tool_result', callId: parentCallId, text: expect.stringContaining('tool-finished') }),
      );
    },
    TURN_MS,
  );

  it(
    'runs a background shell past the turn, reporting its start and its end as a background task',
    async () => {
      const ctx = start({ permission: () => ({ outcome: 'selected', optionId: 'allow' }) });
      await turn(ctx, '/background');
      expect(ctx.permissions).toHaveLength(1);
      expect(ctx.permissions[0]).toMatchObject({ toolName: 'bash_background', kind: 'execute' });
      const call = ctx.entries().find((entry) => entry.entryType === 'tool_call' && entry.toolName === 'bash_background');
      const callId = call?.entryType === 'tool_call' ? call.callId : undefined;
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'background_task', kind: 'shell', status: 'running', callId }),
      );
      // The command prints for about three seconds: it ends after the turn.
      await ctx.waitFor(
        (event) => event.type === 'entries' && event.entries.some((entry) => entry.entryType === 'background_task' && entry.status === 'completed'),
        TURN_MS,
      );
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'background_task', status: 'completed', summary: 'Exited with code 0' }),
      );
    },
    TURN_MS,
  );

  it(
    "stops a background task from the phone, with what it started, and says it was stopped",
    async () => {
      const ctx = start({ permission: () => ({ outcome: 'selected', optionId: 'allow' }) });
      await turn(ctx, '/background node -e "setInterval(function(){},1000)"');
      const running = ctx.entries().find((entry) => entry.entryType === 'background_task' && entry.status === 'running');
      expect(running).toBeDefined();
      const taskId = running!.entryType === 'background_task' ? running!.taskId : '';
      await session!.stopTask!(taskId);
      await ctx.waitFor(
        (event) => event.type === 'entries' && event.entries.some((entry) => entry.entryType === 'background_task' && entry.status === 'stopped'),
        TURN_MS,
      );
      await expect(session!.stopTask!(taskId)).rejects.toThrow(/no running task/);
    },
    TURN_MS,
  );

  it(
    "hands the project's TypeScript errors back with a write, and shows the write as a diff",
    async () => {
      // A TypeScript project as one is checked out: its node_modules holds
      // TypeScript and typescript-language-server — here the agent host's
      // own (devDependencies), linked in. Nothing comes from PATH.
      writeFileSync(path.join(cwd, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"noEmit":true}}');
      symlinkSync(HOST_NODE_MODULES, path.join(cwd, 'node_modules'), 'junction');
      const ctx = start({ permission: () => ({ outcome: 'selected', optionId: 'allow' }) });
      await turn(ctx, '/write src/a.ts const x: number = "s";\\nexport { x };');

      expect(readFileSync(path.join(cwd, 'src', 'a.ts'), 'utf8')).toBe('const x: number = "s";\nexport { x };');
      const call = ctx.entries().find((entry) => entry.entryType === 'tool_call' && entry.toolName === 'write');
      const callId = call?.entryType === 'tool_call' ? call.callId : undefined;
      expect(callId).toBeDefined();
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({
          entryType: 'tool_result',
          callId,
          text: expect.stringContaining(
            "typescript-language-server reports 1 error in src/a.ts:\nsrc/a.ts:1:7 error 2322: Type 'string' is not assignable to type 'number'.",
          ),
        }),
      );
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({
          entryType: 'diff',
          callId,
          path: 'src/a.ts',
          lines: [
            { type: 'add', text: 'const x: number = "s";' },
            { type: 'add', text: 'export { x };' },
          ],
        }),
      );
    },
    TURN_MS,
  );

  it(
    "sizes a gateway's model from Pi's own catalog, which the extension reads inside Pi",
    async () => {
      // A gateway's id names its route before the model; the pinned Pi's
      // catalog serves this model at 1M tokens (opencode-go). The endpoint's
      // list said nothing about its size, as OpenCode Go's does not.
      const routed = 'OpenCode Go/deepseek-v4.1-flash';
      const ctx = start(
        {},
        {
          model: routed,
          provider: {
            id: 'codedeck-fake',
            label: 'Fake gateway',
            baseUrl: modelUrl,
            authToken: 'codedeck-fake-model',
            models: [{ id: routed }],
            defaultModel: routed,
          },
        },
      );
      const info = await ctx.waitFor((event) => event.type === 'info' && event.contextWindow !== undefined, TURN_MS);
      expect(info).toMatchObject({ contextWindow: 1_000_000 });
    },
    TURN_MS,
  );
});
