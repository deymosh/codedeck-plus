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
import { existsSync } from 'node:fs';
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
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
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
