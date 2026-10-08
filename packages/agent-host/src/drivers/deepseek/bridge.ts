/**
 * The driver's side of the socket the plugin listens on (plugin.ts): what a
 * session's commands are, running one line of them, and answering a question
 * the harness's model asked.
 *
 * One connection per request, line-delimited JSON, and `undefined` for
 * anything that does not work out — a harness without the plugin, a plugin
 * that could not start, a timeout. Commands and questions are conveniences:
 * a session runs without them exactly as it did before, and nothing here may
 * fail one.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { connect } from 'node:net';
import { slashCommand } from '../../sdk/commands';
import type { SlashCommand } from '../../sdk/types';

/** How long one question may take. The plugin answers from memory; a command
 *  that does real work (a compaction asks a model) takes as long as it takes,
 *  and the caller's own long timeout is the one that applies. */
const LIST_TIMEOUT_MS = 5_000;
const RUN_TIMEOUT_MS = 10 * 60_000;

/**
 * Where one harness process's plugin listens. Every process has its own: the
 * runtime runs one per environment, so several can be up at once, and two
 * plugins on one path take the file from each other — the second unlinks the
 * first one's socket as it starts, and whichever closes first unlinks the
 * other's, leaving a live process that nothing can reach. `tag` names the
 * process. A file inside the bridge's home on a POSIX machine, and a named
 * pipe on Windows, named after the home too so two bridges on one machine do
 * not collide.
 */
export function bridgeSocketPath(home: string, tag: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const homeTag = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\codedeck-dsh-bridge-${homeTag}-${tag}`;
  }
  return path.join(home, 'codedeck', `dsh-bridge-${tag}.sock`);
}

/** One command as the plugin lists it. */
interface CommandListing {
  name: string;
  description?: string;
  hint?: string;
}

/** The plugin's answer. */
export interface Reply {
  ok: boolean;
  error?: string;
  commands?: CommandListing[];
  result?: { kind: string; text?: string };
  /** For `steer`: whether a running turn took the message. */
  steered?: boolean;
}

/** The commands of one session, or `undefined` when they cannot be read. */
export async function listSessionCommands(
  socket: string,
  sessionId: string,
  log: (message: string) => void,
  timeoutMs: number = LIST_TIMEOUT_MS,
): Promise<SlashCommand[] | undefined> {
  const reply = await askPlugin(socket, { method: 'list', sessionId }, timeoutMs, log);
  if (!reply?.ok) return undefined;
  return (reply.commands ?? [])
    .filter((command) => typeof command.name === 'string' && command.name !== '')
    .map((command) => slashCommand(command.name, command.description, command.hint));
}

/** What running one command line produced, or `undefined` when it did not run
 *  (an unknown command, an unreachable plugin, a failure in the handler). */
export async function runSessionCommand(
  socket: string,
  sessionId: string,
  line: string,
  log: (message: string) => void,
  timeoutMs: number = RUN_TIMEOUT_MS,
): Promise<{ ok: boolean; text: string } | undefined> {
  const reply = await askPlugin(socket, { method: 'run', sessionId, line }, timeoutMs, log);
  if (!reply) return undefined;
  if (!reply.ok) return { ok: false, text: reply.error ?? 'the command could not be run' };
  return { ok: reply.result?.kind !== 'error', text: reply.result?.text ?? '' };
}

/** Hand a message to the turn a session is running, as the harness's own
 *  apps steer one. `false` when there was no turn to take it, or nothing to
 *  ask — the message is then for a prompt of its own. */
export async function steerSession(
  socket: string,
  sessionId: string,
  text: string,
  log: (message: string) => void,
  timeoutMs: number = LIST_TIMEOUT_MS,
): Promise<boolean> {
  const reply = await askPlugin(socket, { method: 'steer', sessionId, text }, timeoutMs, log);
  return reply?.ok === true && reply.steered === true;
}

/** One request to the plugin, one answer. Never throws: a socket that is not
 *  there (no plugin, a harness that has not started) is not an error worth a
 *  stack. */
export async function askPlugin(
  socket: string,
  request: Record<string, unknown>,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<Reply | undefined> {
  const id = 1;
  return new Promise<Reply | undefined>((resolve) => {
    let buffered = '';
    let settled = false;
    const connection = connect(socket);
    const finish = (reply: Reply | undefined, reason?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      if (reply === undefined && reason !== undefined) log(`[deepseek] ${reason}`);
      resolve(reply);
    };
    const timer = setTimeout(() => finish(undefined, `the command bridge did not answer within ${timeoutMs}ms`), timeoutMs);
    timer.unref?.();
    connection.on('error', (error: NodeJS.ErrnoException) => {
      // A missing socket means the plugin is not running: worth one line, not
      // a failure.
      finish(undefined, error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'the command bridge is not running' : error.message);
    });
    connection.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const end = buffered.indexOf('\n');
      if (end < 0) return;
      try {
        const answer = JSON.parse(buffered.slice(0, end)) as Reply & { id?: number };
        if (answer.id !== undefined && answer.id !== id) return;
        finish(answer);
      } catch {
        finish(undefined, 'the command bridge answered something that is not JSON');
      }
    });
    connection.on('close', () => finish(undefined, 'the command bridge closed without answering'));
    connection.on('connect', () => connection.write(`${JSON.stringify({ id, ...request })}\n`));
  });
}
