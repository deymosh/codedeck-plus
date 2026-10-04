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
import { commandsSocketPath, listSessionCommands, runSessionCommand } from '../commands';
import { COMMANDS_PLUGIN, installCommandsPlugin } from '../commandsPlugin';

const socketPathIn = (dir: string): string => path.join(dir, 'commands.sock');

/** A stand-in for the harness's plugin context: the two services the plugin
 *  asks for, the effect disposer, and a logger. */
function pluginContext(commands: unknown, agents: { get: (id: string) => unknown } = { get: () => ({ id: 'a1' }) }) {
  const cleanups: Array<() => void> = [];
  return {
    cleanups,
    ctx: {
      get: (service: string) => (service === 'commands' ? commands : service === 'agents' ? agents : undefined),
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
): Promise<{ cleanups: Array<() => void>; socket: string }> {
  const socket = socketPathIn(profileDir);
  await installCommandsPlugin(profileDir, socket, () => {});
  const module = (await import(pathToFileURL(path.join(profileDir, 'node_modules', COMMANDS_PLUGIN, 'index.js')).href)) as {
    apply: (ctx: unknown, config: unknown) => void;
    name: string;
    inject: string[];
  };
  expect(module.name).toBe('codedeck-commands');
  expect(module.inject).toEqual(['agents', 'commands']);
  const { ctx, cleanups } = pluginContext(commandService, agents);
  module.apply(ctx, { socket });
  return { cleanups, socket };
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
    await installCommandsPlugin(dir, '/tmp/some.sock', () => {});
    const manifest = JSON.parse(readFileSync(path.join(dir, 'node_modules', COMMANDS_PLUGIN, 'package.json'), 'utf8')) as {
      name: string;
      type: string;
      main: string;
    };
    expect(manifest).toMatchObject({ name: COMMANDS_PLUGIN, type: 'module', main: 'index.js' });
    const layer = readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
    expect(layer).toMatch(/CodeDeck\+ commands/);
    expect(layer).toMatch(/- id: codedeck-commands/);
    expect(layer).toMatch(new RegExp(`name: '${COMMANDS_PLUGIN}'`));
    expect(layer).toMatch(/socket: "\/tmp\/some\.sock"/);
    // The profile's own content is still there.
    expect(layer).toMatch(/# the profile/);
  });

  it('leaves the files alone when they are already right', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-cmd-'));
    const write = vi.fn();
    await installCommandsPlugin(dir, '/tmp/a.sock', () => {});
    const first = readFileSync(path.join(dir, 'node_modules', COMMANDS_PLUGIN, 'index.js'), 'utf8');
    // A second run must not rewrite the source the harness may be running —
    // the content check is what makes it safe to run at every start.
    await installCommandsPlugin(dir, '/tmp/a.sock', () => {});
    expect(readFileSync(path.join(dir, 'node_modules', COMMANDS_PLUGIN, 'index.js'), 'utf8')).toBe(first);
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
    expect(commandsSocketPath('/data')).toBe(path.join('/data', 'codedeck', 'dsh-commands.sock'));
    const pipe = commandsSocketPath('/data', 'win32');
    expect(pipe.startsWith('\\\\.\\pipe\\codedeck-dsh-commands-')).toBe(true);
    // Two homes, two pipes: a machine running two bridges must not have them
    // answer each other's questions.
    expect(commandsSocketPath('/data', 'win32')).not.toBe(commandsSocketPath('/other', 'win32'));
  });
});
