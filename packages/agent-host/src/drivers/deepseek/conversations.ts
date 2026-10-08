/**
 * Deleting a harness conversation. The harness has no API for it, so this
 * follows its on-disk layout (dsh-session-persistence-jsonl):
 *
 *   $DSH_HOME/sessions/<project>/<id>/session.v<N>.jsonl[.zstd]
 *
 * where `<project>` is a lossy, truncated encoding of the session's cwd —
 * not recomputed here: a conversation id is a UUID, so it is looked up in
 * every project directory instead. Each subagent conversation is a sibling
 * directory of its own, whose header (the first line of its log) names its
 * parent as `parentSession`, with `origin: "subagent"`; those go too, and
 * their own subagents with them.
 */
import { createReadStream } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createZstdDecompress } from 'node:zlib';

const LOG_FILE = /^session\.v(\d+)\.jsonl(\.zstd)?$/;
/** A header is a short JSON object; anything longer is not one. */
const HEADER_MAX = 64 * 1024;

/** Delete conversation `id` and its subagent conversations from `home`.
 *  Resolves also when there is none. */
export async function deleteDshConversation(home: string, id: string): Promise<void> {
  if (!isSegment(id)) throw new Error(`'${id}' is not a DeepSeek Harness conversation id`);
  const root = path.join(home, 'sessions');
  for (const project of await subdirs(root)) {
    const dir = path.join(root, project);
    const names = await subdirs(dir);
    if (!names.includes(id)) continue;
    const doomed = [id];
    const parentOf = new Map<string, string>();
    for (const name of names) {
      const header = await readHeader(path.join(dir, name));
      if (header?.origin === 'subagent' && typeof header.parentSession === 'string') parentOf.set(name, header.parentSession);
    }
    for (let i = 0; i < doomed.length; i++) {
      for (const [child, parent] of parentOf) if (parent === doomed[i] && !doomed.includes(child)) doomed.push(child);
    }
    for (const name of doomed.reverse()) await rm(path.join(dir, name), { recursive: true, force: true });
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

/** The header of the session in `dir`, from its newest log; undefined when
 *  it has none that reads as one. */
async function readHeader(dir: string): Promise<{ origin?: unknown; parentSession?: unknown } | undefined> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return undefined;
  }
  const version = (name: string) => Number(LOG_FILE.exec(name)?.[1] ?? -1);
  const log = files.filter((f) => LOG_FILE.test(f)).sort((a, b) => version(b) - version(a))[0];
  if (!log) return undefined;
  const line = await firstLine(path.join(dir, log));
  if (line === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The first line of a log, decompressing a `.zstd` one only as far as it.
 *  A log still being written may end in an incomplete frame; the header is
 *  in the first one. */
async function firstLine(file: string): Promise<string | undefined> {
  const source = createReadStream(file);
  const stream = file.endsWith('.zstd') ? source.pipe(createZstdDecompress()) : source;
  source.on('error', (err) => stream.destroy(err));
  const decoder = new StringDecoder('utf8');
  let text = '';
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      text += decoder.write(chunk);
      const end = text.indexOf('\n');
      if (end >= 0) return text.slice(0, end);
      if (text.length > HEADER_MAX) return undefined;
    }
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  } finally {
    source.destroy();
    stream.destroy();
  }
}
