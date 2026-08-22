/**
 * TranscriptStorage/KV contract suite (Phase 3b).
 *
 * One shared behavioral suite runs against BOTH implementations:
 * - Phase 3a's `memoryTranscriptStorage` (the semantic reference), and
 * - `sqliteTranscriptStorage` over an in-process better-sqlite3 database
 *   wrapped to the same `SqlExecutor` seam tauri-plugin-sql is wrapped to.
 * Both must agree — that's the proof the SQLite adapter can replace the
 * in-memory port without touching store logic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { memoryKV, memoryTranscriptStorage, type KV, type TranscriptStorage } from '../../core/ports';
import {
  MIGRATION_STATEMENTS,
  PRUNE_IDLE_SESSION_MAX_AGE_MS,
  PRUNE_MAX_ENTRIES_PER_SESSION,
  SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  pruneTranscripts,
  runMigrations,
  sqliteKv,
  sqliteTranscriptStorage,
  type SqlExecutor,
} from '../sqlite';

/** better-sqlite3 wrapped to the exact seam tauri-plugin-sql is wrapped to. */
function betterSqliteExecutor(db: BetterSqlite3.Database): SqlExecutor {
  return {
    execute: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    select: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

async function makeSqlite(): Promise<{ db: SqlExecutor; storage: TranscriptStorage; kv: KV }> {
  const raw = new BetterSqlite3(':memory:');
  const db = betterSqliteExecutor(raw);
  await runMigrations(db);
  return { db, storage: sqliteTranscriptStorage(db), kv: sqliteKv(db) };
}

const entry = (i: number): unknown => ({
  entryType: 'text',
  content: `entry ${i}`,
  timestamp: new Date(i * 1000).toISOString(),
});

const rows = (...seqs: number[]): Array<{ seq: number; entry: unknown }> =>
  seqs.map((seq) => ({ seq, entry: entry(seq) }));

// --- The shared contract, parameterized over the implementation ---

function transcriptStorageContract(
  name: string,
  make: () => Promise<TranscriptStorage>,
): void {
  describe(`TranscriptStorage contract — ${name}`, () => {
    let storage: TranscriptStorage;
    beforeEach(async () => {
      storage = await make();
    });

    it('insertIgnore stores new rows and returns their seqs', async () => {
      const inserted = await storage.insertIgnore('m1', 's1', rows(1, 2, 3));
      expect(inserted).toEqual([1, 2, 3]);
      expect(await storage.seqs('m1', 's1')).toEqual([1, 2, 3]);
    });

    it('insertIgnore skips already-present seqs (dedup is structural)', async () => {
      await storage.insertIgnore('m1', 's1', rows(1, 2, 3));
      const second = await storage.insertIgnore('m1', 's1', rows(2, 3, 4, 5));
      expect(second).toEqual([4, 5]);
      expect(await storage.seqs('m1', 's1')).toEqual([1, 2, 3, 4, 5]);
    });

    it('insertIgnore keeps the FIRST content for a duplicated seq', async () => {
      await storage.insertIgnore('m1', 's1', [{ seq: 7, entry: entry(7) }]);
      await storage.insertIgnore('m1', 's1', [
        { seq: 7, entry: { entryType: 'error', content: 'imposter', timestamp: 't' } },
      ]);
      const [row] = await storage.readRange('m1', 's1', 7, 7);
      expect(row?.entry).toEqual(entry(7));
    });

    it('insertIgnore with an empty batch is a no-op', async () => {
      expect(await storage.insertIgnore('m1', 's1', [])).toEqual([]);
      expect(await storage.seqs('m1', 's1')).toEqual([]);
    });

    it('seqs come back ascending regardless of insert order', async () => {
      await storage.insertIgnore('m1', 's1', rows(30, 2, 17, 1));
      expect(await storage.seqs('m1', 's1')).toEqual([1, 2, 17, 30]);
    });

    it('readRange returns from<=seq<=to ascending with round-tripped entries', async () => {
      await storage.insertIgnore('m1', 's1', rows(1, 2, 3, 5, 8, 9));
      const range = await storage.readRange('m1', 's1', 2, 8);
      expect(range.map((r) => r.seq)).toEqual([2, 3, 5, 8]);
      expect(range[0]?.entry).toEqual(entry(2));
    });

    it('readRange of an empty/unknown session is empty', async () => {
      expect(await storage.readRange('m1', 'nope', 1, 100)).toEqual([]);
    });

    it('sessions and machines are isolated', async () => {
      await storage.insertIgnore('m1', 's1', rows(1, 2));
      await storage.insertIgnore('m1', 's2', rows(10));
      await storage.insertIgnore('m2', 's1', rows(20));
      expect(await storage.seqs('m1', 's1')).toEqual([1, 2]);
      expect(await storage.seqs('m1', 's2')).toEqual([10]);
      expect(await storage.seqs('m2', 's1')).toEqual([20]);
    });

    it('remove drops exactly one (machine, session)', async () => {
      await storage.insertIgnore('m1', 's1', rows(1, 2));
      await storage.insertIgnore('m1', 's2', rows(3));
      await storage.remove('m1', 's1');
      expect(await storage.seqs('m1', 's1')).toEqual([]);
      expect(await storage.seqs('m1', 's2')).toEqual([3]);
    });
  });
}

transcriptStorageContract('memory reference (3a)', async () => memoryTranscriptStorage());
transcriptStorageContract('sqlite adapter (better-sqlite3)', async () =>
  (await makeSqlite()).storage,
);

// --- KV contract, same pattern ---

function kvContract(name: string, make: () => Promise<KV>): void {
  describe(`KV contract — ${name}`, () => {
    let kv: KV;
    beforeEach(async () => {
      kv = await make();
    });

    it('get of a missing key is undefined', async () => {
      expect(await kv.get('nope')).toBeUndefined();
    });

    it('set/get round-trips, including empty strings and JSON blobs', async () => {
      await kv.set('a', '');
      await kv.set('b', JSON.stringify({ hello: 'wörld', n: [1, 2, 3] }));
      expect(await kv.get('a')).toBe('');
      expect(JSON.parse((await kv.get('b'))!)).toEqual({ hello: 'wörld', n: [1, 2, 3] });
    });

    it('set overwrites', async () => {
      await kv.set('k', 'v1');
      await kv.set('k', 'v2');
      expect(await kv.get('k')).toBe('v2');
    });

    it('delete removes (and is idempotent)', async () => {
      await kv.set('k', 'v');
      await kv.delete('k');
      await kv.delete('k');
      expect(await kv.get('k')).toBeUndefined();
    });
  });
}

kvContract('memory reference (3a)', async () => memoryKV());
kvContract('sqlite adapter (better-sqlite3)', async () => (await makeSqlite()).kv);

// --- SQLite-only: migrations + prune ---

describe('sqlite migrations', () => {
  it('are idempotent and record the schema version', async () => {
    const raw = new BetterSqlite3(':memory:');
    const db = betterSqliteExecutor(raw);
    await runMigrations(db);
    await runMigrations(db); // second boot: no throw
    const kv = sqliteKv(db);
    expect(await kv.get(SCHEMA_VERSION_KEY)).toBe(String(SCHEMA_VERSION));
    expect(MIGRATION_STATEMENTS.every((s) => !s.includes(';'))).toBe(true);
  });
});

describe('pruneTranscripts', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('trims oversized sessions to the newest maxEntriesPerSession seqs', async () => {
    const { db, storage } = await makeSqlite();
    const all = Array.from({ length: 30 }, (_, i) => i + 1);
    await storage.insertIgnore('m1', 'big', rows(...all));
    await storage.insertIgnore('m1', 'small', rows(1, 2, 3));

    const result = await pruneTranscripts(db, { maxEntriesPerSession: 10 });
    expect(result.trimmedRows).toBe(20);
    expect(await storage.seqs('m1', 'big')).toEqual(all.slice(20)); // newest 10 kept
    expect(await storage.seqs('m1', 'small')).toEqual([1, 2, 3]);
  });

  it('drops sessions idle beyond idleSessionMaxAgeMs, keeps active ones', async () => {
    const raw = new BetterSqlite3(':memory:');
    const db = betterSqliteExecutor(raw);
    await runMigrations(db);
    const t0 = 1_000_000_000_000;
    const old = sqliteTranscriptStorage(db, { now: () => t0 - 40 * DAY });
    const fresh = sqliteTranscriptStorage(db, { now: () => t0 - DAY });
    await old.insertIgnore('m1', 'stale', rows(1, 2));
    await fresh.insertIgnore('m1', 'active', rows(1, 2));

    const result = await pruneTranscripts(db, { now: () => t0 });
    expect(result.removedSessions).toBe(1);
    expect(await fresh.seqs('m1', 'stale')).toEqual([]);
    expect(await fresh.seqs('m1', 'active')).toEqual([1, 2]);
  });

  it('a session with ONE recent row is kept whole even if older rows exist', async () => {
    const raw = new BetterSqlite3(':memory:');
    const db = betterSqliteExecutor(raw);
    await runMigrations(db);
    const t0 = 1_000_000_000_000;
    const old = sqliteTranscriptStorage(db, { now: () => t0 - 40 * DAY });
    const fresh = sqliteTranscriptStorage(db, { now: () => t0 });
    await old.insertIgnore('m1', 's', rows(1, 2, 3));
    await fresh.insertIgnore('m1', 's', rows(4));

    const result = await pruneTranscripts(db, { now: () => t0 });
    // Idle is judged by the NEWEST row — an active session never loses history.
    expect(result.removedSessions).toBe(0);
    expect(await fresh.seqs('m1', 's')).toEqual([1, 2, 3, 4]);
  });

  it('no-ops on an empty database and uses the plan defaults', async () => {
    const { db } = await makeSqlite();
    const result = await pruneTranscripts(db);
    expect(result).toEqual({ removedSessions: 0, trimmedRows: 0 });
    expect(PRUNE_MAX_ENTRIES_PER_SESSION).toBe(5_000);
    expect(PRUNE_IDLE_SESSION_MAX_AGE_MS).toBe(30 * DAY);
  });
});
