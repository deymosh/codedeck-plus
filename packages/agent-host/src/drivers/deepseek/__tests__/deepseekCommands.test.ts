/**
 * The command bridge: the plugin CodeDeck writes into the harness profile,
 * run here as the harness would run it (a fake plugin context and a real
 * socket), and the client the driver asks it questions with.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { askPlugin, bridgeSocketPath, listSessionCommands, runSessionCommand, steerSession } from '../bridge';
import { BRIDGE_SOCKET_ENV, HARNESS_PLUGIN, QUESTION_MARKER, installHarnessPlugin } from '../plugin';
import { parseQuestionLine, planReviewOf, toAnswerItems, toQuestionSpecs } from '../questions';

const socketPathIn = (dir: string): string => path.join(dir, 'commands.sock');

/** A stand-in for the harness's plugin context: the two services the plugin
 *  asks for, the effect disposer, and a logger. */
function pluginContext(commands: unknown, agents: { get: (id: string) => unknown } = { get: () => ({ id: 'a1' }) }) {
  const cleanups: Array<() => void> = [];
  /** What the plugin registered with `ctx.on`, by event name. */
  const listeners = new Map<string, (payload: never, next: () => never) => unknown>();
  return {
    cleanups,
    listeners,
    ctx: {
      get: (service: string) => (service === 'commands' ? commands : service === 'agents' ? agents : undefined),
      on: (event: string, listener: (payload: never, next: () => never) => unknown) => {
        listeners.set(event, listener);
      },
      logger: { warn: () => {}, debug: () => {} },
      effect: (callback: () => () => void) => {
        cleanups.push(callback());
      },
    },
  };
}

/** Run the plugin's source the way the harness does: import it and apply it. */
async function runPlugin(
  profileDir: string,
  commandService: unknown,
  agents: { get: (id: string) => unknown } = { get: () => ({ id: 'a1' }) },
): Promise<{
  cleanups: Array<() => void>;
  socket: string;
  listeners: Map<string, (payload: never, next: () => never) => unknown>;
}> {
  const socket = socketPathIn(profileDir);
  await installHarnessPlugin(profileDir, () => {});
  const module = (await import(pathToFileURL(path.join(profileDir, 'node_modules', HARNESS_PLUGIN, 'index.js')).href)) as {
    apply: (ctx: unknown) => void;
    name: string;
    inject: string[];
  };
  expect(module.name).toBe('codedeck-bridge');
  expect(module.inject).toEqual(['agents', 'commands', 'userQuestions']);
  const { ctx, cleanups, listeners } = pluginContext(commandService, agents);
  // The runtime names each process's socket in its environment; the plugin
  // reads it as it applies.
  process.env[BRIDGE_SOCKET_ENV] = socket;
  try {
    module.apply(ctx);
  } finally {
    delete process.env[BRIDGE_SOCKET_ENV];
  }
  return { cleanups, socket, listeners };
}

/** Wait for a socket to accept a connection (the plugin listens asynchronously). */
async function waitForSocket(socket: string): Promise<void> {
  const { connect } = await import('node:net');
  for (let attempt = 0; attempt < 100; attempt++) {
    const connected = await new Promise<boolean>((resolve) => {
      const probe = connect(socket);
      probe.on('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.on('error', () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`nothing is listening on ${socket}`);
}

describe('installing the command plugin', () => {
  it('writes its package into the profile and its row into the layer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    writeFileSync(path.join(dir, 'cordis.patch.yml'), '# the profile\n[]\n');
    await installHarnessPlugin(dir, () => {});
    const manifest = JSON.parse(readFileSync(path.join(dir, 'node_modules', HARNESS_PLUGIN, 'package.json'), 'utf8')) as {
      name: string;
      type: string;
      main: string;
    };
    expect(manifest).toMatchObject({ name: HARNESS_PLUGIN, type: 'module', main: 'index.js' });
    const layer = readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
    expect(layer).toMatch(/CodeDeck\+ bridge/);
    expect(layer).toMatch(/- id: codedeck-bridge/);
    expect(layer).toMatch(new RegExp(`name: '${HARNESS_PLUGIN}'`));
    // The row names no socket: the profile is shared by every process, and
    // each process has its own.
    expect(layer).not.toMatch(/socket:/);
    // The profile's own content is still there.
    expect(layer).toMatch(/# the profile/);
  });

  it('leaves the files alone when they are already right', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const write = vi.fn();
    await installHarnessPlugin(dir, () => {});
    const first = readFileSync(path.join(dir, 'node_modules', HARNESS_PLUGIN, 'index.js'), 'utf8');
    // A second run must not rewrite the source the harness may be running —
    // the content check is what makes it safe to run at every start.
    await installHarnessPlugin(dir, () => {});
    expect(readFileSync(path.join(dir, 'node_modules', HARNESS_PLUGIN, 'index.js'), 'utf8')).toBe(first);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('the plugin in a harness CodeDeck did not start', () => {
  it('neither listens nor takes questions it could never answer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    await installHarnessPlugin(dir, () => {});
    const module = (await import(pathToFileURL(path.join(dir, 'node_modules', HARNESS_PLUGIN, 'index.js')).href)) as {
      apply: (ctx: unknown) => void;
    };
    const { ctx, cleanups, listeners } = pluginContext({ list: () => [] });
    delete process.env[BRIDGE_SOCKET_ENV];
    module.apply(ctx);
    // The harness's own "no answerer" stands, rather than a question that
    // waits on a host that is not there.
    expect(listeners.size).toBe(0);
    expect(cleanups).toEqual([]);
  });
});

describe('the plugin, talking to the driver', () => {
  const commands = {
    list: () => [
      { name: 'compact', description: 'Compact the conversation', input: { hint: '[<focus>]' } },
      { name: 'goal', description: 'Set or view the goal', input: { hint: '[<objective>]', attachments: true } },
      { name: 'plain', description: 'No input at all' },
    ],
    execute: (_agent: unknown, line: string) =>
      line.startsWith('/compact')
        ? Promise.resolve({ commandId: 'c1', result: { kind: 'success', text: 'Compacted 12 messages.' } })
        : Promise.resolve(undefined),
  };

  it('steers a running agent with a message of the harness\'s own making, and leaves an idle one alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const steered: unknown[] = [];
    const agent = { id: 'a1', status: 'running', steer: (message: unknown) => steered.push(message) };
    const { cleanups, socket } = await runPlugin(dir, commands, { get: () => agent });
    await waitForSocket(socket);
    // The plugin builds the message with the harness it runs in, found from
    // the CLI node was started with: here, the harness this repo pins.
    const argv = process.argv[1] ?? '';
    process.argv[1] = fileURLToPath(new URL('../../../../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url));
    try {
      expect(await steerSession(socket, 's1', 'use the other parser', () => {})).toBe(true);
      expect(steered).toHaveLength(1);
      expect(steered[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'use the other parser' }] });
      agent.status = 'idle';
      // No turn to take it: the host prompts it instead.
      expect(await steerSession(socket, 's1', 'and then?', () => {})).toBe(false);
      expect(steered).toHaveLength(1);
    } finally {
      process.argv[1] = argv;
      for (const cleanup of cleanups) cleanup();
    }
  });

  it('lists them, with the hint the harness gives', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const { cleanups, socket } = await runPlugin(dir, commands);
    await waitForSocket(socket);
    expect(await listSessionCommands(socket, 's1', () => {})).toEqual([
      { name: 'compact', description: 'Compact the conversation', argumentHint: '[<focus>]' },
      { name: 'goal', description: 'Set or view the goal', argumentHint: '[<objective>]' },
      { name: 'plain', description: 'No input at all' },
    ]);
    for (const cleanup of cleanups) cleanup();
  });

  it('runs one line and reports what it said, and says so when it cannot', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const { cleanups, socket } = await runPlugin(dir, commands);
    await waitForSocket(socket);
    expect(await runSessionCommand(socket, 's1', '/compact now', () => {})).toEqual({ ok: true, text: 'Compacted 12 messages.' });
    // The harness answers `undefined` for a line it does not have: that is a
    // refusal to report, not a success with no text.
    const unknown = await runSessionCommand(socket, 's1', '/nope', () => {});
    expect(unknown?.ok).toBe(false);
    for (const cleanup of cleanups) cleanup();
  });

  it('reports a session the harness does not have', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const { cleanups, socket } = await runPlugin(dir, { ...commands, list: () => [] }, { get: () => undefined });
    await waitForSocket(socket);
    expect(await listSessionCommands(socket, 'gone', () => {})).toBeUndefined();
    for (const cleanup of cleanups) cleanup();
  });

  it('answers a command whose handler failed as an error', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const failing = {
      list: () => [],
      execute: () => Promise.resolve({ commandId: 'c2', result: { kind: 'error', text: 'nothing to compact' } }),
    };
    const { cleanups, socket } = await runPlugin(dir, failing);
    await waitForSocket(socket);
    expect(await runSessionCommand(socket, 's1', '/compact', () => {})).toEqual({ ok: false, text: 'nothing to compact' });
    for (const cleanup of cleanups) cleanup();
  });
});

describe('questions, through the plugin', () => {
  /** One question as the harness's model asks it. */
  const asked = {
    questions: [
      {
        id: 'q1',
        question: 'Which database?',
        header: 'Storage',
        options: [{ label: 'SQLite' }, { label: 'Postgres', description: 'A server' }],
      },
    ],
    agent: { session: { id: 's1' } },
    signal: new AbortController().signal,
    wait: { callId: 'c1' },
  };

  it('pushes it to the host on stderr and returns what the host answers with', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const { cleanups, socket, listeners } = await runPlugin(dir, { list: () => [], execute: () => Promise.resolve(undefined) });
    await waitForSocket(socket);
    const pushed: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      pushed.push(String(chunk));
      return true;
    });
    const listener = listeners.get('user-questions/request')!;
    const pending = listener(asked as never, () => Promise.reject(new Error('delegated')) as never);
    stderr.mockRestore();

    // The host learns about it on stderr — the stream ACP does not own.
    const line = pushed.find((chunk) => chunk.includes(QUESTION_MARKER));
    expect(line).toBeDefined();
    const parsed = parseQuestionLine(line!, QUESTION_MARKER)!;
    expect(parsed).toMatchObject({ sessionId: 's1', callId: 'c1' });
    expect(parsed.questions[0]).toMatchObject({ id: 'q1', question: 'Which database?', header: 'Storage' });

    // And answers on the socket, which is what the harness's tool returns.
    await askPlugin(socket, { method: 'answer', callId: 'c1', sessionId: 's1', answer: [{ id: 'q1', selected: ['SQLite'] }] }, 2_000, () => {});
    expect(await pending).toEqual({ answers: [{ id: 'q1', selected: ['SQLite'] }] });
    for (const cleanup of cleanups) cleanup();
  });

  it('tells the model it was not answered when the host says nothing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const { cleanups, socket, listeners } = await runPlugin(dir, { list: () => [], execute: () => Promise.resolve(undefined) });
    await waitForSocket(socket);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const pending = listeners.get('user-questions/request')!(asked as never, () => Promise.reject(new Error('delegated')) as never);
    stderr.mockRestore();
    // The handler is attached before the answer arrives: a rejection nobody
    // is waiting on yet is an unhandled one.
    const refused = expect(pending).rejects.toThrow(/did not answer/);
    await askPlugin(socket, { method: 'answer', callId: 'c1', sessionId: 's1' }, 2_000, () => {});
    await refused;
    for (const cleanup of cleanups) cleanup();
  });

  it('shows a plan review, whose ask names no wait, and returns the verdict', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const { cleanups, socket, listeners } = await runPlugin(dir, { list: () => [], execute: () => Promise.resolve(undefined) });
    await waitForSocket(socket);
    const pushed: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      pushed.push(String(chunk));
      return true;
    });
    // The plan review of `exit_plan_mode` asks the same service the question
    // tool does: the plan is the question's detail, and the call id is on its
    // intent — there is no `wait` to read it from.
    const review = {
      questions: [
        {
          id: 'plan-review',
          header: 'Plan review',
          question: 'Approve this plan and leave plan mode?',
          detail: '# Ship the harness\n\nDo the thing.',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }],
          intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-7' },
        },
      ],
      agent: { session: { id: 's1' } },
      signal: new AbortController().signal,
    };
    const pending = listeners.get('user-questions/request')!(review as never, () => Promise.reject(new Error('delegated')) as never);
    stderr.mockRestore();

    const parsed = parseQuestionLine(pushed.find((chunk) => chunk.includes(QUESTION_MARKER))!, QUESTION_MARKER)!;
    expect(parsed).toMatchObject({ sessionId: 's1', callId: 'call-7' });
    expect(toQuestionSpecs(parsed.questions)).toEqual([
      {
        question: 'Approve this plan and leave plan mode?\n\n# Ship the harness\n\nDo the thing.',
        header: 'Plan review',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      },
    ]);

    // The verdict travels back as the harness reads it: the chosen label.
    await askPlugin(
      socket,
      { method: 'answer', callId: 'call-7', sessionId: 's1', answer: toAnswerItems(parsed.questions, ['Approve']) },
      2_000,
      () => {},
    );
    expect(await pending).toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] });
    for (const cleanup of cleanups) cleanup();
  });

  it('asks under a key of its own when the request names none', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const { cleanups, socket, listeners } = await runPlugin(dir, { list: () => [], execute: () => Promise.resolve(undefined) });
    await waitForSocket(socket);
    const pushed: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      pushed.push(String(chunk));
      return true;
    });
    const pending = listeners.get('user-questions/request')!(
      { questions: [{ id: 'q1', question: 'And now?' }], agent: { session: { id: 's1' } } } as never,
      () => Promise.reject(new Error('delegated')) as never,
    );
    stderr.mockRestore();

    const parsed = parseQuestionLine(pushed.find((chunk) => chunk.includes(QUESTION_MARKER))!, QUESTION_MARKER)!;
    expect(parsed.callId).not.toBe('');
    await askPlugin(socket, { method: 'answer', callId: parsed.callId, sessionId: 's1', answer: [{ id: 'q1', selected: [] }] }, 2_000, () => {});
    expect(await pending).toEqual({ answers: [{ id: 'q1', selected: [] }] });
    for (const cleanup of cleanups) cleanup();
  });

  it('hands a request it cannot show to the next answerer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const { cleanups, listeners } = await runPlugin(dir, { list: () => [], execute: () => Promise.resolve(undefined) });
    const listener = listeners.get('user-questions/request')!;
    // `next()` is how a waterfall listener passes a request on. Returning
    // without it vetoes the chain and leaves the caller with `undefined` where
    // the answer batch belongs — a crash wherever the ask's result is read.
    const delegated = vi.fn(() => Promise.resolve({ answers: [] }));
    const nothingAsked = await listener({ questions: [], agent: { session: { id: 's1' } } } as never, delegated as never);
    const noSession = await listener({ questions: [{ id: 'q1', question: 'Q?' }] } as never, delegated as never);
    expect([nothingAsked, noSession]).toEqual([{ answers: [] }, { answers: [] }]);
    expect(delegated).toHaveBeenCalledTimes(2);
    for (const cleanup of cleanups) cleanup();
  });
});

describe('what the host makes of a question', () => {
  it('shows the harness questions as the wire ones, detail and all', () => {
    const specs = toQuestionSpecs([
      { id: 'q1', question: 'Which database?', header: 'Storage', options: [{ label: 'SQLite' }, { label: 'Postgres', description: 'A server' }] },
      { id: 'q2', question: 'Anything else?', detail: 'A line of context.', multiSelect: true },
    ]);
    expect(specs).toEqual([
      {
        question: 'Which database?',
        header: 'Storage',
        options: [{ label: 'SQLite' }, { label: 'Postgres', description: 'A server' }],
      },
      { question: 'Anything else?\n\nA line of context.', options: [], multiSelect: true },
    ]);
  });

  it('answers the way the harness takes an answer: labels, or what was typed', () => {
    const questions = [
      { id: 'q1', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
      { id: 'q2', question: 'Anything else?' },
      { id: 'q3', question: 'Which parts?', options: [{ label: 'api' }, { label: 'app' }], multiSelect: true },
    ];
    expect(toAnswerItems(questions, ['SQLite', 'a note', 'api, app'])).toEqual([
      { id: 'q1', selected: ['SQLite'] },
      { id: 'q2', selected: [], custom: 'a note' },
      { id: 'q3', selected: ['api', 'app'] },
    ]);
    // A multi-select answered with something that is not a list of its own
    // labels is text the user typed, not labels.
    expect(toAnswerItems(questions, ['Postgres', 'a, b', 'api, something else'])[2]).toEqual({
      id: 'q3',
      selected: [],
      custom: 'api, something else',
    });
  });

  it('reads a pushed line, and ignores anything that is not one', () => {
    const line = `${QUESTION_MARKER}${JSON.stringify({ sessionId: 's1', callId: 'c1', questions: [{ id: 'q1', question: 'Q?' }] })}`;
    expect(parseQuestionLine(line, QUESTION_MARKER)).toEqual({ sessionId: 's1', callId: 'c1', questions: [{ id: 'q1', question: 'Q?' }] });
    expect(parseQuestionLine('the harness logging something', QUESTION_MARKER)).toBeUndefined();
    expect(parseQuestionLine(`${QUESTION_MARKER}not json`, QUESTION_MARKER)).toBeUndefined();
    expect(parseQuestionLine(`${QUESTION_MARKER}{"questions":[]}`, QUESTION_MARKER)).toBeUndefined();
    // What an ask is for travels with it: a plan review is told from a plain
    // question by nothing else.
    const withIntent = `${QUESTION_MARKER}${JSON.stringify({
      sessionId: 's1',
      callId: 'c1',
      questions: [{ id: 'q1', question: 'Q?', intent: { kind: 'plan-review', approve: 'Approve' } }],
    })}`;
    expect(parseQuestionLine(withIntent, QUESTION_MARKER)?.questions[0]?.intent).toEqual({ kind: 'plan-review', approve: 'Approve' });
  });

  it('reads a plan review out of an ask, and leaves plain questions alone', () => {
    expect(planReviewOf([{ id: 'q1', question: 'Q?' }])).toBeUndefined();
    // Nothing to show, or nothing to choose: an ordinary question either way.
    expect(planReviewOf([{ id: 'q1', question: 'Q?', intent: { kind: 'plan-review' } }])).toBeUndefined();
    expect(
      planReviewOf([{ id: 'q1', question: 'Q?', detail: '# P', intent: { kind: 'plan-review' } }]),
    ).toBeUndefined();
    expect(
      planReviewOf([
        {
          id: 'plan-review',
          header: 'Plan review',
          question: 'Approve this plan and leave plan mode?',
          detail: '# Ship it',
          options: [{ label: 'Approve', description: 'Go.' }, { label: 'Keep planning' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        },
      ]),
    ).toEqual({
      id: 'plan-review',
      plan: '# Ship it',
      // The label is the option id: that is what the harness reads back.
      options: [
        { id: 'Approve', label: 'Approve', description: 'Go.' },
        { id: 'Keep planning', label: 'Keep planning' },
      ],
      // Not the approval: the choice the user's feedback goes with.
      revise: 'Keep planning',
    });
  });
});

describe('the client on its own', () => {
  /** A socket that answers whatever the test scripts (or nothing at all). */
  async function fakeBridge(answer: (request: Record<string, unknown>, socket: Socket) => void): Promise<{ socket: string; close: () => void }> {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const socket = socketPathIn(dir);
    const server: Server = createServer((connection) => {
      connection.setEncoding('utf8');
      let buffered = '';
      connection.on('data', (chunk: string) => {
        buffered += chunk;
        const end = buffered.indexOf('\n');
        if (end < 0) return;
        answer(JSON.parse(buffered.slice(0, end)) as Record<string, unknown>, connection);
      });
      connection.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return { socket, close: () => server.close() };
  }

  it('answers nothing when no plugin is there', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const logs: string[] = [];
    expect(await listSessionCommands(socketPathIn(dir), 's1', (line) => logs.push(line))).toBeUndefined();
    expect(logs.some((line) => /command bridge is not running/.test(line))).toBe(true);
  });

  it('answers nothing on a malformed reply, a wrong id, or no reply at all', async () => {
    const malformed = await fakeBridge((_request, socket) => socket.write('not json at all\n'));
    expect(await runSessionCommand(malformed.socket, 's1', '/x', () => {}, 2_000)).toBeUndefined();
    malformed.close();

    const silent = await fakeBridge(() => {});
    const logs: string[] = [];
    expect(await listSessionCommands(silent.socket, 's1', (line) => logs.push(line), 50)).toBeUndefined();
    expect(logs.some((line) => /did not answer within 50ms/.test(line))).toBe(true);
    silent.close();
  });

  it('forgets about a command name that is not a name', async () => {
    const bridge = await fakeBridge((_request, socket) =>
      socket.write(`${JSON.stringify({ id: 1, ok: true, commands: [{ name: '' }, { name: 'ok' }] })}\n`),
    );
    expect((await listSessionCommands(bridge.socket, 's1', () => {}))?.map((command) => command.name)).toEqual(['ok']);
    bridge.close();
  });
});

describe('the socket path', () => {
  it('is one per harness process, and a named pipe on Windows', () => {
    expect(bridgeSocketPath('/data', 'a1')).toBe(path.join('/data', 'codedeck', 'dsh-bridge-a1.sock'));
    // Two processes of one home never share a socket: the second would take
    // the first one's file, and whichever closed first would unlink the
    // other's.
    expect(bridgeSocketPath('/data', 'a1')).not.toBe(bridgeSocketPath('/data', 'b2'));
    const pipe = bridgeSocketPath('/data', 'a1', 'win32');
    expect(pipe.startsWith('\\\\.\\pipe\\codedeck-dsh-bridge-')).toBe(true);
    // Two homes, two pipes: a machine running two bridges must not have them
    // answer each other's questions.
    expect(bridgeSocketPath('/data', 'a1', 'win32')).not.toBe(bridgeSocketPath('/other', 'a1', 'win32'));
  });
});
