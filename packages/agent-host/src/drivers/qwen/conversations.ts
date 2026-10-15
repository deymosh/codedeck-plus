/**
 * Deleting a Qwen Code conversation.
 *
 * Qwen Code does have a `deleteSession` extension method, but it is served by
 * a live process and its own `SessionService`, and the host's delete hook runs
 * after the session has ended — so this follows the on-disk layout instead,
 * which is what a stopped machine has anyway:
 *
 *   $QWEN_HOME/projects/<cwd-slug>/chats/<id>.jsonl
 *   $QWEN_HOME/plans/<id>.md
 *
 * `<cwd-slug>` is a lossy encoding of the session's cwd, not recomputed here:
 * a conversation id is a UUID, so every project directory is searched instead.
 * The plan a session left behind is named by the same id, so it goes too.
 */
import { readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';

/** Delete conversation `id` from `home`. Resolves also when there is none. */
export async function deleteQwenConversation(home: string, id: string): Promise<void> {
  if (!isSegment(id)) throw new Error(`'${id}' is not a Qwen Code conversation id`);
  // The transcript, under whichever project directory it was written.
  for (const project of await subdirs(path.join(home, 'projects'))) {
    const chats = path.join(home, 'projects', project, 'chats');
    for (const name of await files(chats)) {
      if (name === `${id}.jsonl` || name.startsWith(`${id}.`)) await rm(path.join(chats, name), { force: true });
    }
  }
  // The plan file a plan-mode session writes, named by the session's id.
  for (const name of await files(path.join(home, 'plans'))) {
    if (name === `${id}.md`) await rm(path.join(home, 'plans', name), { force: true });
  }
}

function isSegment(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..' && !/[/\\]/.test(id);
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function files(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}
