/**
 * Commands OpenCode's terminal runs itself and its server does not list:
 * compacting the conversation, undoing and redoing turns, sharing it. Each
 * runs through the server's API, and its outcome is a status line in the
 * transcript (the transcript keeps what an undo took back; the line says
 * so). A command the server lists under the same name — a project's own —
 * is the one that runs.
 */
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { slashCommand } from '../../sdk/commands';
import type { SlashCommand } from '../../sdk/types';

/** What a command works on and how it reports back. */
export interface SessionCommandContext {
  client: OpencodeClient;
  sessionID: string;
  directory: string;
  /** The model the session's prompts name, if one was chosen. */
  model?: { providerID: string; modelID: string };
  status(text: string): void;
}

interface SessionCommand {
  name: string;
  description: string;
  run(ctx: SessionCommandContext): Promise<void>;
}

/** A failed call's reason, for the error entry. */
function failure(what: string, error: unknown): Error {
  const detail = typeof error === 'object' && error !== null && 'data' in error ? (error as { data: unknown }).data : error;
  return new Error(`OpenCode could not ${what}: ${JSON.stringify(detail)}`);
}

/** The first line of a prompt, short enough to name it in a status line. */
function gist(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** The user turns of a session, oldest first, with their text. */
async function userTurns(ctx: SessionCommandContext): Promise<Array<{ id: string; text: string }>> {
  const { data, error } = await ctx.client.session.messages({ sessionID: ctx.sessionID, directory: ctx.directory });
  if (error || !data) throw failure('read the conversation', error);
  return data
    .filter((m) => m.info.role === 'user')
    .map((m) => ({
      id: m.info.id,
      text: m.parts.flatMap((p) => (p.type === 'text' && !p.synthetic ? [p.text] : [])).join('\n'),
    }));
}

async function revertPoint(ctx: SessionCommandContext): Promise<string | undefined> {
  const { data, error } = await ctx.client.session.get({ sessionID: ctx.sessionID, directory: ctx.directory });
  if (error || !data) throw failure('read the session', error);
  return data.revert?.messageID;
}

export const SESSION_COMMANDS: SessionCommand[] = [
  {
    name: 'compact',
    description: 'Summarize the conversation so far, to free up context',
    async run(ctx) {
      ctx.status('Compacting the conversation…');
      const { error } = await ctx.client.session.summarize({
        sessionID: ctx.sessionID,
        directory: ctx.directory,
        ...(ctx.model ?? {}),
      });
      if (error) throw failure('compact the conversation', error);
      ctx.status('Compacted: OpenCode continues from a summary of the conversation.');
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
      const { error } = await ctx.client.session.revert({ sessionID: ctx.sessionID, directory: ctx.directory, messageID: last.id });
      if (error) throw failure('undo the last turn', error);
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
      const { error } = await ctx.client.session.unrevert({ sessionID: ctx.sessionID, directory: ctx.directory });
      if (error) throw failure('redo', error);
      ctx.status('Brought back the undone turns and their file changes.');
    },
  },
  {
    name: 'share',
    description: 'Publish the conversation at a link anyone can open',
    async run(ctx) {
      const { data, error } = await ctx.client.session.share({ sessionID: ctx.sessionID, directory: ctx.directory });
      if (error || !data) throw failure('share the conversation', error);
      ctx.status(data.share?.url ? `Shared at ${data.share.url} — anyone with the link can read it. /unshare stops it.` : 'Shared.');
    },
  },
  {
    name: 'unshare',
    description: 'Stop sharing the conversation',
    async run(ctx) {
      const { error } = await ctx.client.session.unshare({ sessionID: ctx.sessionID, directory: ctx.directory });
      if (error) throw failure('stop sharing the conversation', error);
      ctx.status('The conversation is no longer shared.');
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
