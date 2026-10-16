/**
 * The real Qwen Code CLI against the local model server (tools/fake-model.mjs)
 * — one session per scenario, asserted on the entries this driver translates.
 *
 * What this covers that the scripted-agent tests cannot: the CLI's own ACP
 * session lifecycle, the provider settings this driver writes (its only way to
 * point Qwen Code at an endpoint), the tool round trip with the permission
 * card the agent asks for, the question form's answer, and the mode switch a
 * session started off Qwen Code's own default makes.
 *
 * It costs nothing and reaches nothing — the model server answers every
 * request, and the profile the session runs on points at it. The CLI is the
 * devDependency pnpm-lock.yaml pins (install.ts), so this runs where that is
 * installed — CI included — and skips, saying so, where it is not. The model
 * server is started as its own process, from its own entry point, because a
 * driver test may not reach outside its folder for a module to import.
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QwenDriver } from '../driver';
import { bundledQwenExecutable } from '../install';
import { QwenRuntime } from '../runtime';
import { recordingContext, type Handlers } from '../../../sdk/__tests__/context';
import type { DriverSession } from '../../../sdk/driver';
import type { ProviderBinding, StartSession } from '../../../sdk/types';

/** The local model server, and the model it answers as (both from its own
 *  module: this file may not import it, so they are named here). */
const MODEL_SERVER = fileURLToPath(new URL('../../../../tools/fake-model.mjs', import.meta.url));
const FAKE_MODEL_ID = 'fake-model-1';

interface FakeModelServer {
  url: string;
  stop(): Promise<void>;
}

/** Start the server on an OS-chosen port and wait for the URL it logs. */
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

const qwenPath = bundledQwenExecutable();
if (!qwenPath) {
  // Said once, at collection: a skip with no reason reads like a broken test.
  console.warn('qwenFakeModel: no Qwen Code CLI beside the host — skipping the live fake-model tests');
}
const live = qwenPath ? describe : describe.skip;

/** How long a turn may take: process start plus one request to a loopback
 *  server. The suite's own 20 s is the floor, not the bar. */
const TURN_MS = 60_000;

live('Qwen Code against the fake model', () => {
  let model: FakeModelServer | undefined;
  let modelUrl = '';
  let cwd: string;
  let home: string;
  let session: DriverSession | undefined;

  beforeEach(async () => {
    model = await startFakeModel();
    modelUrl = model.url;
    cwd = await mkdtemp(path.join(tmpdir(), 'codedeck-qwen-fake-'));
    home = await mkdtemp(path.join(tmpdir(), 'codedeck-qwen-home-'));
  });

  afterEach(async () => {
    await session?.end();
    session = undefined;
    await model?.stop();
    model = undefined;
    // Retried: the CLI writes its transcripts under the home as it shuts
    // down, and a directory it recreates mid-removal is not a test failure.
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** A session on the profile the bridge would hand the driver: the endpoint
   *  is where the session's requests go, and its model is the only one the
   *  session may name. */
  function start(handlers: Handlers = {}, overrides: Partial<StartSession> = {}) {
    const ctx = recordingContext(handlers);
    const runtime = new QwenRuntime({
      qwenPath: qwenPath!,
      home,
      cacheDir: path.join(home, 'agents'),
      // Never reached: an explicit path is the operator's own CLI.
      installQwen: async () => qwenPath!,
      idleCloseMs: 0,
      log: () => {},
    });
    const driver = QwenDriver.create({ runtime, home, baseEnv: process.env, log: () => {} });
    const profile: ProviderBinding = {
      id: 'codedeck-fake',
      label: 'Fake model',
      baseUrl: modelUrl,
      authToken: 'codedeck-fake-model',
      models: [{ id: FAKE_MODEL_ID, label: 'Fake model' }],
      defaultModel: FAKE_MODEL_ID,
    };
    const ready = driver.setProviders([profile]);
    session = driver.startSession(
      { sessionId: randomUUID(), agent: 'qwen-code', cwd, model: FAKE_MODEL_ID, ...overrides },
      ctx,
    );
    void ready;
    return ctx;
  }

  /** One prompt and the turn it runs. */
  async function turn(ctx: ReturnType<typeof recordingContext>, text: string) {
    await ctx.waitFor((e) => e.type === 'ready', TURN_MS);
    const idle = ctx.waitFor((e) => e.type === 'turn' && e.state === 'idle', TURN_MS);
    session!.prompt(text);
    await idle;
  }

  it(
    'reports the prompt echoed back as the agent’s own text',
    async () => {
      const ctx = start();
      await turn(ctx, 'hello from the fake model');
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'text', role: 'agent', text: 'echo: hello from the fake model' }),
      );
    },
    TURN_MS,
  );

  it(
    'runs the tool call a scenario scripts, through a permission card',
    async () => {
      // The scenario's own command (a write), not `/tool echo …`: Qwen Code
      // approves a plain `echo` itself, so it would raise no card.
      const ctx = start({
        permission: (request) => {
          expect(request.toolName).toBe('run_shell_command');
          expect(request.title).toContain('codedeck-fake-model');
          const allow = request.options.find((option) => option.kind === 'allow_once');
          return { outcome: 'selected', optionId: allow!.id };
        },
      });
      await turn(ctx, '/tool');
      const entries = ctx.entries();
      expect(ctx.permissions).toHaveLength(1);
      expect(entries).toContainEqual(expect.objectContaining({ entryType: 'tool_call', toolName: 'run_shell_command' }));
      // The agent's own result text: the command it ran and what came back.
      expect(entries).toContainEqual(
        expect.objectContaining({
          entryType: 'tool_result',
          callId: 'call_fake_1',
          text: expect.stringContaining('echo codedeck-fake-model > codedeck-fake-model.txt'),
        }),
      );
      expect(entries.some((entry) => entry.entryType === 'error')).toBe(false);
    },
    TURN_MS,
  );

  it(
    'asks the question a scenario scripts, and carries the answer back',
    async () => {
      const ctx = start({ question: () => ({ outcome: 'answered', answers: [{ type: 'selected', labels: ['Red'] }] }) });
      await turn(ctx, '/question');
      expect(ctx.questions).toHaveLength(1);
      expect(ctx.questions[0]!.questions[0]).toMatchObject({
        question: 'Which color?',
        options: [{ label: 'Red' }, { label: 'Blue' }],
      });
      // The question tool's own row is the card, so the exchange shows as no
      // tool entry at all. (That the reply carries `answers` keyed by the
      // question's position is asserted in qwenDriver.test.ts.)
      expect(ctx.entries().some((entry) => entry.entryType === 'tool_call')).toBe(false);
      expect(ctx.entries().some((entry) => entry.entryType === 'error')).toBe(false);
    },
    TURN_MS,
  );

  it(
    'runs a session on the mode the bridge asked for, not Qwen Code’s own default',
    async () => {
      const ctx = start({}, { mode: 'yolo' });
      await ctx.waitFor((e) => e.type === 'ready', TURN_MS);
      const info = ctx.events.find((e) => e.type === 'info' && 'mode' in e);
      expect(info).toMatchObject({ type: 'info', mode: 'yolo' });
    },
    TURN_MS,
  );
});
