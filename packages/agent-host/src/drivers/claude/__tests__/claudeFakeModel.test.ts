/**
 * The real Claude Code binary against the local model server
 * (tools/fake-model.mjs) — one session per scenario, asserted on the entries
 * this driver translates.
 *
 * What this covers that the scripted-facade tests cannot: the CLI's own
 * request and stream handling, the tool round trip, the question form's
 * answer, an API error, and the context figure the agent derives from its
 * own token accounting. It costs nothing and reaches nothing — the model
 * server answers every request — and the session names the fake model, which
 * is what the CLI's own banner then shows.
 *
 * The binary is the platform package the Agent SDK ships, the one the driver
 * itself falls back to (install.ts), so this runs wherever that package is
 * installed — CI included — and skips, saying so, where it is not. The model
 * server is started as its own process, from its own entry point, because a
 * driver test may not reach outside its folder for a module to import.
 *
 * Timing: each test spawns the real CLI and runs one turn, so these are
 * slower than the rest of the suite; the timeouts are generous on purpose,
 * because a slow runner must not read as a failure.
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeDriver } from '../driver';
import { RealSdkFacade } from '../facade';
import { bundledClaudeExecutable } from '../install';
import { recordingContext, type Handlers } from '../../../sdk/__tests__/context';
import type { DriverSession } from '../../../sdk/driver';
import type { StartSession } from '../../../sdk/types';

/** The local model server, and the model it answers as (both from its own
 *  module: this file may not import it, so they are named here). */
const MODEL_SERVER = fileURLToPath(new URL('../../../../tools/fake-model.mjs', import.meta.url));
const FAKE_MODEL_ID = 'fake-model-1';

/** What one run of the server hands back: where it listens, and how to stop
 *  it. */
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
      // Killed on the way out, not left behind: a server that never printed
      // its URL still holds its stdio pipes open, and a leaked child keeps
      // vitest from exiting — which would hide the failure it just reported.
      void stopServer(child);
      reject(new Error(`the fake model did not start: ${output}`));
    }, timeoutMs);
    const stop = () => stopServer(child);
    const onOutput = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve({ url: match[1]!, stop });
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the fake model exited (${code}): ${output}`));
    });
  });
}

/** Stop it, and do not wait forever for a process that ignores the signal. */
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

const claudePath = bundledClaudeExecutable();
if (!claudePath) {
  // Said once, at collection: a skip with no reason reads like a broken test.
  console.warn('claudeFakeModel: no Claude Code binary beside the SDK — skipping the live fake-model tests');
}
const live = claudePath ? describe : describe.skip;

/** How long a turn may take: process start plus one request to a loopback
 *  server. The suite's own 20 s is the floor, not the bar. */
const TURN_MS = 60_000;

live('Claude Code against the fake model', () => {
  let model: FakeModelServer | undefined;
  let modelUrl = '';
  let cwd: string;
  let session: DriverSession | undefined;

  beforeEach(async () => {
    model = await startFakeModel();
    modelUrl = model.url;
    cwd = await mkdtemp(path.join(tmpdir(), 'codedeck-fake-model-'));
  });

  afterEach(async () => {
    await session?.end();
    session = undefined;
    // Optional both ways round: a test whose server never started must still
    // clean up its directory, and must fail with why the server did not
    // start rather than with what the cleanup tripped over.
    await model?.stop();
    model = undefined;
    await rm(cwd, { recursive: true, force: true });
  });

  /** A session bound to the fake model the way the bridge binds one to a
   *  provider profile: the profile's endpoint is where the session's
   *  requests go, and its model is the only one the session may name. */
  function start(handlers: Handlers = {}, overrides: Partial<StartSession> = {}) {
    const ctx = recordingContext(handlers);
    const driver = new ClaudeDriver({ facade: new RealSdkFacade(), claudePath: claudePath! });
    session = driver.startSession(
      {
        sessionId: randomUUID(),
        agent: 'claude-code',
        cwd,
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

  /** One prompt and the turn it runs; the context holds everything the
   *  session reported by the time the turn is over. */
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
    'runs the tool call a scenario scripts, and reports its result',
    async () => {
      const ctx = start();
      await turn(ctx, '/tool echo codedeck-fake-model');
      const entries = ctx.entries();
      expect(entries).toContainEqual(expect.objectContaining({ entryType: 'tool_call', toolName: 'Bash' }));
      expect(entries).toContainEqual(
        expect.objectContaining({ entryType: 'tool_result', text: expect.stringContaining('codedeck-fake-model') }),
      );
      // The request that follows a tool result is answered from that result,
      // which is what ends the turn rather than calling the model again.
      expect(entries).toContainEqual(
        expect.objectContaining({ entryType: 'text', text: expect.stringContaining('tool-finished') }),
      );
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
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'text', text: expect.stringContaining('"Which color?"="Red"') }),
      );
    },
    TURN_MS,
  );

  it(
    'reports the API error a scenario answers with',
    async () => {
      const ctx = start();
      await turn(ctx, '/error');
      // Claude Code reports a failed request as its own text, not as an
      // error entry — that is what the phone is shown, so it is what the
      // test asserts.
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'text', text: expect.stringContaining('the fake model was asked to fail') }),
      );
    },
    TURN_MS,
  );

  it(
    'reports the long answer, and the context the agent counts from it',
    async () => {
      const ctx = start();
      await turn(ctx, '/long');
      expect(ctx.entries()).toContainEqual(
        expect.objectContaining({ entryType: 'text', text: expect.stringContaining('line 80 of the long answer') }),
      );
      const usage = await session!.getUsage();
      expect(usage?.context?.usedTokens ?? 0).toBeGreaterThan(0);
      expect(usage?.context?.windowTokens ?? 0).toBeGreaterThan(0);
    },
    TURN_MS,
  );
});
