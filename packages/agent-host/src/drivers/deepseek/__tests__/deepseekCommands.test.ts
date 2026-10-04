/**
 * The command bridge: the plugin CodeDeck writes into the harness profile,
 * run here as the harness would run it (a fake plugin context and a real
 * socket), and the client the driver asks it questions with.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { askPlugin, bridgeSocketPath, listSessionCommands, runSessionCommand } from '../bridge';
import { HARNESS_PLUGIN, QUESTION_MARKER, installHarnessPlugin } from '../plugin';
import { parseQuestionLine, toAnswerItems, toQuestionSpecs } from '../questions';

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
  await installHarnessPlugin(profileDir, socket, () => {});
  const module = (await import(pathToFileURL(path.join(profileDir, 'node_modules', HARNESS_PLUGIN, 'index.js')).href)) as {
    apply: (ctx: unknown, config: unknown) => void;
    name: string;
    inject: string[];
  };
  expect(module.name).toBe('codedeck-bridge');
  expect(module.inject).toEqual(['agents', 'commands', 'userQuestions']);
  const { ctx, cleanups, listeners } = pluginContext(commandService, agents);
  module.apply(ctx, { socket });
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
    await installHarnessPlugin(dir, '/tmp/some.sock', () => {});
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
    expect(layer).toMatch(/socket: "\/tmp\/some\.sock"/);
    // The profile's own content is still there.
    expect(layer).toMatch(/# the profile/);
  });

  it('leaves the files alone when they are already right', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const write = vi.fn();
    await installHarnessPlugin(dir, '/tmp/a.sock', () => {});
    const first = readFileSync(path.join(dir, 'node_modules', HARNESS_PLUGIN, 'index.js'), 'utf8');
    // A second run must not rewrite the source the harness may be running —
    // the content check is what makes it safe to run at every start.
    await installHarnessPlugin(dir, '/tmp/a.sock', () => {});
    expect(readFileSync(path.join(dir, 'node_modules', HARNESS_PLUGIN, 'index.js'), 'utf8')).toBe(first);
    expect(write).not.toHaveBeenCalled();
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

  it('leaves a question it cannot key to another answerer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const { cleanups, listeners } = await runPlugin(dir, { list: () => [], execute: () => Promise.resolve(undefined) });
    const listener = listeners.get('user-questions/request')!;
    expect(await listener({ questions: [] } as never, () => Promise.reject(new Error('delegated')) as never)).toBeUndefined();
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
  it('is one file per home, and a named pipe on Windows', () => {
    expect(bridgeSocketPath('/data')).toBe(path.join('/data', 'codedeck', 'dsh-bridge.sock'));
    const pipe = bridgeSocketPath('/data', 'win32');
    expect(pipe.startsWith('\\\\.\\pipe\\codedeck-dsh-bridge-')).toBe(true);
    // Two homes, two pipes: a machine running two bridges must not have them
    // answer each other's questions.
    expect(bridgeSocketPath('/data', 'win32')).not.toBe(bridgeSocketPath('/other', 'win32'));
  });
});
