/**
 * TranscriptStore — persistent, append-only session transcripts.
 *
 * DELIBERATE REWRITE of the old bridge's history subsystem, which caused the
 * "phone loses session history" bug: in-memory seq counters (restart = seq
 * reset + renumbering colliding with phone dedup), a 500-entry in-memory cap,
 * and a disk fallback keyed by cwd that was skipped when afterSeq > 0.
 *
 * Design rules:
 * - One JSONL file per session at <stateDir>/transcripts/<sessionId>.jsonl,
 *   keyed by sessionId ONLY (never cwd). Each line: {seq, entry}.
 * - seq is assigned once at append (starting at 1) and NEVER renumbered —
 *   prune keeps original seqs, restart recovers seqHigh from disk.
 * - Writes are serialized per session so concurrent appends can't interleave.
 * - Crash-safe boot: a torn final line (partial write) is detected and
 *   truncated away; seqHigh recovers from the last valid line.
 */
import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import type { OutputEntry, SeqRange } from '@codedeck/protocol';

export interface TranscriptLine {
  seq: number;
  entry: OutputEntry;
}

/** Structural check for a parsed JSONL line — enough to reject torn/corrupt lines. */
function isValidLine(value: unknown): value is TranscriptLine {
  if (typeof value !== 'object' || value === null) { return false; }
  const rec = value as Record<string, unknown>;
  return (
    typeof rec['seq'] === 'number' &&
    Number.isInteger(rec['seq']) &&
    rec['seq'] >= 1 &&
    typeof rec['entry'] === 'object' &&
    rec['entry'] !== null
  );
}

function parseLine(raw: string): TranscriptLine | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') { return undefined; }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isValidLine(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * CDX-066: temp-name sequence shared by EVERY TranscriptStore in this process —
 * the same hardening registry.ts got for CDX-060, applied to the same disease.
 * A per-instance counter means two stores over the same state dir (the
 * reopen/restart pattern the tests and the bridge's own recovery use, same pid)
 * both mint `<session>.jsonl.tmp-<pid>-1`, `-2`, … — so when their writes
 * interleave the second writer's rename(2) fires against a temp path the first
 * has already renamed away and throws `ENOENT rename …`. A module-level counter
 * makes the name unique per write per process; the pid keeps it unique across
 * processes.
 */
let sharedTmpSeq = 0;

export class TranscriptStore {
  private readonly dir: string;
  private readonly logFn?: (msg: string) => void;
  /** In-memory seq high-water mark per session (recovered from disk at open). */
  private readonly seqHighs = new Map<string, number>();
  /** Per-session write chain — serializes file operations so appends never interleave. */
  private readonly queues = new Map<string, Promise<unknown>>();

  private constructor(stateDir: string, log?: (msg: string) => void) {
    this.dir = path.join(stateDir, 'transcripts');
    this.logFn = log;
  }

  /**
   * Open the store rooted at <stateDir>/transcripts, recovering seqHigh for
   * every session file on disk and repairing torn final lines.
   */
  static async open(stateDir: string, log?: (msg: string) => void): Promise<TranscriptStore> {
    const store = new TranscriptStore(stateDir, log);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const files = await fs.readdir(this.dir);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) { continue; }
      const sessionId = decodeURIComponent(file.slice(0, -'.jsonl'.length));
      try {
        const seqHigh = await this.recoverFile(path.join(this.dir, file));
        this.seqHighs.set(sessionId, seqHigh);
      } catch (err) {
        this.log(`[Transcript] Failed to recover ${file}: ${err}`);
      }
    }
  }

  /**
   * Read one transcript file, drop invalid lines (a crash can tear only the
   * final line, but we tolerate corruption anywhere), rewrite the file if any
   * line was dropped, and return the recovered seqHigh.
   */
  private async recoverFile(filePath: string): Promise<number> {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split('\n');
    const valid: string[] = [];
    let seqHigh = 0;
    let dropped = 0;
    for (const line of lines) {
      if (line.trim() === '') { continue; }
      const parsed = parseLine(line);
      if (parsed) {
        valid.push(line);
        seqHigh = Math.max(seqHigh, parsed.seq);
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      this.log(`[Transcript] ${path.basename(filePath)}: truncating ${dropped} torn/invalid line(s)`);
      const content = valid.length > 0 ? valid.join('\n') + '\n' : '';
      await this.atomicWrite(filePath, content);
    }
    return seqHigh;
  }

  private fileFor(sessionId: string): string {
    return path.join(this.dir, `${encodeURIComponent(sessionId)}.jsonl`);
  }

  private enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    // Run regardless of the predecessor's outcome — one failed write must not
    // wedge the session's queue forever.
    const next = prev.then(fn, fn);
    this.queues.set(sessionId, next.catch(() => undefined));
    return next;
  }

  /** Write-temp-then-rename, with the CDX-066 (= CDX-060) hardening. */
  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const attempt = async (): Promise<void> => {
      const tmp = `${filePath}.tmp-${process.pid}-${++sharedTmpSeq}`;
      await fs.writeFile(tmp, content, 'utf8');
      await fs.rename(tmp, filePath);
    };
    try {
      await attempt();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
      // ENOENT on rename is a lost race — something removed our temp file
      // between write and rename (a second store over the same dir, or a
      // test-teardown sweep racing an in-flight recover/prune). The content is
      // still current, so retry once under a fresh temp name. If the directory
      // itself is gone, the retry's writeFile throws ENOENT too and the failure
      // propagates like any other.
      await attempt();
    }
  }

  /**
   * Append one entry. The seq is assigned synchronously at call time (so call
   * order — not I/O completion order — determines numbering) and is never
   * renumbered. Resolves once the line is durably appended.
   */
  append(sessionId: string, entry: OutputEntry): Promise<{ seq: number }> {
    const seq = (this.seqHighs.get(sessionId) ?? 0) + 1;
    this.seqHighs.set(sessionId, seq);
    const line = JSON.stringify({ seq, entry }) + '\n';
    return this.enqueue(sessionId, async () => {
      await fs.appendFile(this.fileFor(sessionId), line, 'utf8');
      return { seq };
    });
  }

  /** Highest seq persisted (or being persisted) for a session; 0 if unknown. */
  seqHigh(sessionId: string): number {
    return this.seqHighs.get(sessionId) ?? 0;
  }

  /** Session ids known to the store (from disk at open + appends since). */
  sessions(): string[] {
    return [...this.seqHighs.keys()];
  }

  /**
   * CDX-013: resolve once every enqueued write across all sessions has flushed.
   * Must be awaited on shutdown BEFORE the process can be restarted — otherwise
   * an appendFile still in flight can be read half-written by the next boot's
   * recoverFile, which drops the torn line and recovers a LOWER seqHigh, so the
   * resumed session re-uses a seq the phone already received live (the ~0.16%
   * seq conflict the soak surfaced under restart-mid-stream).
   */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.catch(() => undefined)));
  }

  /**
   * Read all entries with from <= seq <= to, in file (= seq) order. Streams the
   * file; invalid lines are skipped. Queued behind pending writes so callers
   * read their own completed appends.
   */
  readRange(sessionId: string, [from, to]: SeqRange): Promise<TranscriptLine[]> {
    return this.enqueue(sessionId, async () => {
      const out: TranscriptLine[] = [];
      let stream: ReturnType<typeof createReadStream>;
      try {
        await fs.access(this.fileFor(sessionId));
        stream = createReadStream(this.fileFor(sessionId), { encoding: 'utf8' });
      } catch {
        return out; // no file yet — nothing persisted
      }
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const raw of rl) {
          const parsed = parseLine(raw);
          if (parsed && parsed.seq >= from && parsed.seq <= to) {
            out.push(parsed);
          }
        }
      } finally {
        rl.close();
        stream.destroy();
      }
      return out;
    });
  }

  /**
   * Keep only the last `keepLast` entries, rewriting the file atomically
   * (temp + rename). Seqs are NOT renumbered — the file simply starts at a
   * higher seq, and seqHigh is unchanged.
   */
  prune(sessionId: string, keepLast: number): Promise<void> {
    return this.enqueue(sessionId, async () => {
      const filePath = this.fileFor(sessionId);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch {
        return; // nothing to prune
      }
      const valid = raw.split('\n').filter((line) => parseLine(line) !== undefined);
      if (valid.length <= keepLast) { return; }
      const kept = keepLast > 0 ? valid.slice(-keepLast) : [];
      const content = kept.length > 0 ? kept.join('\n') + '\n' : '';
      await this.atomicWrite(filePath, content);
    });
  }

  /** Delete a session's transcript file and forget its seq counter. */
  remove(sessionId: string): Promise<void> {
    const result = this.enqueue(sessionId, async () => {
      try {
        await fs.unlink(this.fileFor(sessionId));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
      }
    });
    this.seqHighs.delete(sessionId);
    return result;
  }

  private log(msg: string): void {
    this.logFn?.(msg);
  }
}
