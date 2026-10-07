/**
 * The harness's profile patch layer, edited in delimited blocks.
 *
 * A profile is an ordered stack of patch layers, and
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml` is the user's own — the
 * file the harness's own documentation says to edit, applied after every
 * bundle. More than one thing this bridge keeps lives there (its MCP server
 * rows, the model catalog it writes for a gateway), so each of them owns a
 * block: exactly the lines between its own two marker comments. Everything
 * else — the profile's comments, a row a person added — is read, kept and
 * written back as it was.
 *
 * Writes are serialised per file (one editor at a time, whichever block it
 * owns) and atomic: written beside and renamed, because a torn write leaves a
 * profile the harness cannot read at all.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** A block's markers: the lines that bound the text this bridge owns. */
export interface LayerBlock {
  /** The line that opens it — what identifies the block in the file. */
  readonly begin: string;
  /** The line that closes it. */
  readonly end: string;
}

/** One file's editors, so two blocks never write over each other. */
const queues = new Map<string, Promise<unknown>>();

export class ProfileLayer {
  constructor(
    private readonly file: string,
    private readonly log?: (message: string) => void,
  ) {}

  /** The layer as it is on disk (`''` for a profile nobody has started). */
  async text(): Promise<string> {
    try {
      return await readFile(this.file, 'utf8');
    } catch {
      return '';
    }
  }

  /** One block's own rows, without its markers. */
  async body(block: LayerBlock): Promise<string | undefined> {
    const text = await this.text();
    const start = text.indexOf(block.begin);
    if (start < 0) return undefined;
    const end = text.indexOf(block.end, start);
    if (end < 0) return undefined;
    return text.slice(start + block.begin.length, end).trim();
  }

  /**
   * Write one block — its rows, with the markers around them — leaving every
   * other byte of the layer alone. `undefined` takes the block out. Answers
   * whether the file changed.
   */
  set(block: LayerBlock, body: string | undefined): Promise<boolean> {
    return this.serial(async () => {
      const text = await this.text();
      const content = nextLayer(text, block, body);
      if (content === text) return false;
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.codedeck-${process.pid}`;
      await writeFile(temporary, content);
      await rename(temporary, this.file);
      this.log?.(`[deepseek] profile layer updated in ${this.file}`);
      return true;
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.file);
    const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
    queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }
}

/**
 * The layer after one write: the block replaced where it already stands — so
 * a start that changes nothing leaves the file byte for byte as it was, and
 * the blocks do not drift through a file a person is reading — or appended
 * when the layer has none yet.
 *
 * Taking a block out leaves one blank line behind, never a growing pile: a
 * layer rewritten at every start must not grow on every start.
 */
function nextLayer(text: string, block: LayerBlock, body: string | undefined): string {
  const rendered = body === undefined || body.trim() === '' ? undefined : `${block.begin}\n${body.trim()}\n${block.end}`;
  const start = text.indexOf(block.begin);
  const end = start < 0 ? -1 : text.indexOf(block.end, start);
  if (rendered === undefined) {
    if (start < 0 || end < 0) return text;
    const before = text.slice(0, start).replace(/\s+$/, '');
    const after = text.slice(end + block.end.length).replace(/^\s+/, '');
    const joined = before === '' ? after : after === '' ? before : `${before}\n\n${after}`;
    return document(joined, false);
  }
  if (start >= 0 && end >= 0) {
    return document(`${text.slice(0, start)}${rendered}${text.slice(end + block.end.length)}`, true);
  }
  return document(addRows(text, rendered), true);
}

/** One document, ending in a newline. Rows live in a sequence, so the
 *  harness's empty-list line cannot stay beside them — and comes back when
 *  nothing but the layer's own comments is left. */
function document(text: string, hasRows: boolean): string {
  const trimmed = text.trimEnd();
  const body = !hasRows && isEmptyLayer(trimmed) ? restoreEmptyList(trimmed) : hasRows ? withoutEmptyList(trimmed) : trimmed;
  return `${body}\n`;
}

/** Whether a profile patch layer holds anything but comments and blanks. */
function isEmptyLayer(text: string): boolean {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // The profile's initial layer: an empty list, and nothing else.
    if (trimmed === '[]' || trimmed === '---') continue;
    return false;
  }
  return true;
}

/**
 * The layer's own rows, then this block, as one document. The harness's
 * initial layer is an empty list (`[]`) on its own, and an empty sequence
 * cannot share a document with a block sequence — nor can a `[]` a user left
 * after their own rows — so those lines go.
 */
function addRows(rest: string, block: string): string {
  const head = withoutEmptyList(rest).trimEnd();
  return head === '' ? block : `${head}\n\n${block}`;
}

/** The layer with no block of ours in it: the profile's own comments and its
 *  empty list, which is the shape the harness starts from. */
function restoreEmptyList(rest: string): string {
  if (!isEmptyLayer(rest)) return rest.trimEnd();
  const head = rest
    .split('\n')
    .filter((line) => line.trim().startsWith('#'))
    .join('\n')
    .trimEnd();
  return head === '' ? '[]' : `${head}\n[]`;
}

/** `text` without a line that is an empty-list document (`[]` at the left
 *  margin; an argument's own `[]` is indented and kept). */
function withoutEmptyList(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.replace(/\r$/, '') !== '[]')
    .join('\n');
}
