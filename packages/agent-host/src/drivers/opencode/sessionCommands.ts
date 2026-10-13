/**
 * Commands OpenCode's terminal runs itself and its server does not list:
 * compacting the conversation, undoing and redoing turns. Each runs through
 * the server's API, and its outcome is a status line in the transcript (the
 * transcript keeps what an undo took back; the line says so). A command the
 * server lists under the same name — a project's own — is the one that runs.
 *
 * V2 has no sharing of a conversation at a link, so `/share` and `/unshare`
 * are gone rather than listed and failing.
 */
import type { OpenCodeClient } from '@opencode/client';
import { slashCommand } from '../../sdk/commands';
import type { SlashCommand } from '../../sdk/types';

/** What a command works on and how it reports back. */
export interface SessionCommandContext {
  client: OpenCodeClient;
  sessionID: string;
  /** The model the session runs, if one was chosen. */
  model?: { providerID: string; id: string };
  status(text: string): void;
}

interface SessionCommand {
  name: string;
  description: string;
  run(ctx: SessionCommandContext): Promise<void>;
}

/** A failed call's reason, for the error entry. */
function failure(what: string, error: unknown): Error {
  const detail =
    error && typeof error === 'object' && 'message' in error ? (error as { message: unknown }).message : error;
  return new Error(`OpenCode could not ${what}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

/** The first line of a prompt, short enough to name it in a status line. */
function gist(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** The user turns of a session, oldest first, with their text. */
async function userTurns(ctx: SessionCommandContext): Promise<Array<{ id: string; text: string }>> {
  const listed = await ctx.client.message.list({ sessionID: ctx.sessionID }).catch((err: unknown) => {
    throw failure('read the conversation', err);
  });
  return listed.data
    .filter((m) => m.type === 'user')
    .map((m) => ({ id: m.id, text: m.type === 'user' ? m.text : '' }));
}

async function revertPoint(ctx: SessionCommandContext): Promise<string | undefined> {
  const session = await ctx.client.session.get({ sessionID: ctx.sessionID }).catch((err: unknown) => {
    throw failure('read the session', err);
  });
  return session.revert?.messageID;
}

export const SESSION_COMMANDS: SessionCommand[] = [
  {
    name: 'compact',
    description: 'Summarize the conversation so far, to free up context',
    async run(ctx) {
      ctx.status('Compacting the conversation…');
      // The request is queued to the next safe point, so the turn carrying it
      // is what reports the outcome.
      const queued = await ctx.client.session.compact({ sessionID: ctx.sessionID }).catch((err: unknown) => {
        throw failure('compact the conversation', err);
      });
      void queued;
      ctx.status('Compacting: OpenCode continues from a summary of the conversation.');
    },
  },
  {
    name: 'undo',
    description: 'Take back the last turn and the file changes it made',
    async run(ctx) {
      const [turns, point] = await Promise.all([userTurns(ctx), revertPoint(ctx)]);
      // Turns from the revert point on are already undone.
      const live = point ? turns.slice(0, Math.max(0, turns.findIndex((t) => t.id === point))) : turns;
      const last = live.at(-1);
      if (!last) {
        ctx.status('Nothing to undo.');
        return;
      }
      await ctx.client.session.revert
        .stage({ sessionID: ctx.sessionID, messageID: last.id, files: true })
        .catch((err: unknown) => {
          throw failure('undo the last turn', err);
        });
      ctx.status(
        `Undid "${gist(last.text)}" and the file changes it made. OpenCode forgets it with your next message; /redo brings it back before then.`,
      );
    },
  },
  {
    name: 'redo',
    description: 'Bring back the turns /undo took back',
    async run(ctx) {
      if (!(await revertPoint(ctx))) {
        ctx.status('Nothing to redo.');
        return;
      }
      await ctx.client.session.revert.clear({ sessionID: ctx.sessionID }).catch((err: unknown) => {
        throw failure('redo', err);
      });
      ctx.status('Brought back the undone turns and their file changes.');
    },
  },
];

/** The built-in command named `name`, unless the server lists one so named. */
export function sessionCommand(name: string, listed: ReadonlySet<string>): SessionCommand | undefined {
  return listed.has(name) ? undefined : SESSION_COMMANDS.find((c) => c.name === name);
}

/** The built-ins for the command menu, beside the `listed` ones. */
export function sessionSlashCommands(listed: ReadonlySet<string>): SlashCommand[] {
  return SESSION_COMMANDS.filter((c) => !listed.has(c.name)).map((c) => slashCommand(c.name, c.description));
}
