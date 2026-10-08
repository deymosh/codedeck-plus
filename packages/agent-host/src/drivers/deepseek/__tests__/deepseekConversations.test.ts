/**
 * Deleting a harness conversation from its on-disk layout: the conversation,
 * its subagents (found through their headers, compressed or not), and
 * nothing else.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteDshConversation } from '../conversations';

let home: string;

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

/** A session directory whose log starts with `header`, then one event. */
async function session(project: string, id: string, header: Record<string, unknown> = {}, zstd = true): Promise<string> {
  const dir = path.join(home, 'sessions', project, id);
  await mkdir(dir, { recursive: true });
  const head = `${JSON.stringify({ type: 'session', version: 4, id, ...header })}\n`;
  const body = `${JSON.stringify({ type: 'event' })}\n`;
  const content = zstd
    ? Buffer.concat([zstdCompressSync(Buffer.from(head)), zstdCompressSync(Buffer.from(body))])
    : Buffer.from(head + body);
  await writeFile(path.join(dir, zstd ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl'), content);
  await writeFile(path.join(dir, 'session.lock'), '');
  return dir;
}

const subagentOf = (parent: string) => ({ origin: 'subagent', parentSession: parent });

describe('deleting a DeepSeek Harness conversation', () => {
  it('removes it with its subagents, theirs, and nothing else', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'dsh-home-'));
    const target = await session('--w--', 'a');
    const child = await session('--w--', 'a-child', subagentOf('a'));
    const grandchild = await session('--w--', 'a-grandchild', subagentOf('a-child'), false);
    const sibling = await session('--w--', 'b');
    const othersChild = await session('--w--', 'b-child', subagentOf('b'));
    const elsewhere = await session('--x--', 'c');

    await deleteDshConversation(home, 'a');

    for (const gone of [target, child, grandchild]) expect(existsSync(gone)).toBe(false);
    for (const kept of [sibling, othersChild, elsewhere]) expect(existsSync(kept)).toBe(true);
  });

  it('finds it in whichever project it was run in', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'dsh-home-'));
    const target = await session('--some-project~0020dir--', 'a');
    await deleteDshConversation(home, 'a');
    expect(existsSync(target)).toBe(false);
  });

  it('nothing to delete is not an error; an id that is not a path segment is', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'dsh-home-'));
    await expect(deleteDshConversation(home, 'missing')).resolves.toBeUndefined();
    await session('--w--', 'a');
    await expect(deleteDshConversation(home, '../--w--')).rejects.toThrow(/not a DeepSeek Harness conversation id/);
    expect(existsSync(path.join(home, 'sessions', '--w--', 'a'))).toBe(true);
  });
});
