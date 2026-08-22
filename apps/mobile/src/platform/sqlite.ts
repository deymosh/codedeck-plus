/**
 * SQLite adapters for the phone core's persistence ports (CDX-009 Phase 3b).
 *
 * `sqliteTranscriptStorage` implements the core's `TranscriptStorage` port and
 * `sqliteKv` implements `KV`, both over a minimal `SqlExecutor` seam so the
 * SAME adapter code runs against:
 * - the in-crate `sql_*` Tauri commands in the real app (see `tauriSqlite.ts`;
 *   tauri-plugin-sql until CDX-012 — replaced because its sqlx conflicts with
 *   MDK's rusqlite on the linked sqlite3 native lib), and
 * - an in-process better-sqlite3 database in vitest (see
 *   `__tests__/sqliteStorage.test.ts`), where the semantics are verified
 *   against Phase 3a's `memoryTranscriptStorage` reference with one shared
 *   contract suite.
 *
 * Schema (plan §5): `transcript(machine_pubkey, session_id, seq, kind, json,
 * created_at)` with PK `(machine_pubkey, session_id, seq)` — `INSERT OR
 * IGNORE` makes dedup structural; range queries drive haveRanges + the list.
 * `kv(key, value)` backs the store persistence (machines/outbox/settings/
 * identity/cursor) — NEVER raw localStorage.
 *
 * Prune policy (plan §5): keep the last `maxEntriesPerSession` (5k) entries
 * per session, drop sessions idle for more than `idleSessionMaxAgeMs` (30
 * days). `pruneTranscripts` is a plain callable — the shell invokes it at boot
 * and on a daily tick (connectivity.ts).
 */
import type { KV, TranscriptEntryRow, TranscriptStorage } from '../core/ports';

/**
 * The minimal SQL seam both the in-crate sql_* commands and the better-sqlite3
 * test wrapper are adapted to. Statements are single statements (no `;`
 * batches) with `?` positional parameters.
 */
export interface SqlExecutor {
  execute(sql: string, params?: unknown[]): Promise<void>;
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

// --- Migrations (run at boot, idempotent) ---

export const SCHEMA_VERSION = 1;

/** Single statements only — the SqlExecutor contract (rusqlite `execute` takes one at a time). */
export const MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transcript (
    machine_pubkey TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (machine_pubkey, session_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_session_created
    ON transcript (machine_pubkey, session_id, created_at)`,
];

export const SCHEMA_VERSION_KEY = 'schema.version';

/** Create/upgrade the schema. Idempotent; records the version in kv. */
export async function runMigrations(db: SqlExecutor): Promise<void> {
  for (const statement of MIGRATION_STATEMENTS) {
    await db.execute(statement);
  }
  await db.execute(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SCHEMA_VERSION_KEY, String(SCHEMA_VERSION)],
  );
}

// --- KV adapter ---

export function sqliteKv(db: SqlExecutor): KV {
  return {
    get: async (key) => {
      const rows = await db.select<{ value: string }>(
        'SELECT value FROM kv WHERE key = ?',
        [key],
      );
      return rows[0]?.value;
    },
    set: async (key, value) => {
      await db.execute(
        `INSERT INTO kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    },
    delete: async (key) => {
      await db.execute('DELETE FROM kv WHERE key = ?', [key]);
    },
  };
}

// --- Transcript adapter ---

/** OutputEntry's discriminator, extracted defensively (the port keeps the
 *  entry opaque; `kind` is denormalized for ad-hoc queries/debugging only). */
function kindOf(entry: unknown): string {
  if (typeof entry === 'object' && entry !== null) {
    const t = (entry as { entryType?: unknown }).entryType;
    if (typeof t === 'string') return t;
  }
  return '';
}

export interface SqliteTranscriptStorageOptions {
  now?: () => number;
}

export function sqliteTranscriptStorage(
  db: SqlExecutor,
  opts: SqliteTranscriptStorageOptions = {},
): TranscriptStorage {
  const now = opts.now ?? Date.now;
  return {
    insertIgnore: async (machine, session, rows) => {
      if (rows.length === 0) return [];
      // Which of the candidate seqs are already stored? (INSERT OR IGNORE
      // doesn't report per-row outcomes through the executor seam, so we
      // diff before inserting — safe: the transcript store serializes all
      // mutations on one write queue.)
      const placeholders = rows.map(() => '?').join(', ');
      const existing = await db.select<{ seq: number }>(
        `SELECT seq FROM transcript
         WHERE machine_pubkey = ? AND session_id = ? AND seq IN (${placeholders})`,
        [machine, session, ...rows.map((r) => r.seq)],
      );
      const already = new Set(existing.map((r) => Number(r.seq)));
      const createdAt = now();
      const inserted: number[] = [];
      for (const { seq, entry } of rows) {
        if (already.has(seq)) continue;
        await db.execute(
          `INSERT OR IGNORE INTO transcript
             (machine_pubkey, session_id, seq, kind, json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [machine, session, seq, kindOf(entry), JSON.stringify(entry), createdAt],
        );
        inserted.push(seq);
      }
      return inserted;
    },

    seqs: async (machine, session) => {
      const rows = await db.select<{ seq: number }>(
        `SELECT seq FROM transcript
         WHERE machine_pubkey = ? AND session_id = ?
         ORDER BY seq ASC`,
        [machine, session],
      );
      return rows.map((r) => Number(r.seq));
    },

    readRange: async (machine, session, from, to) => {
      const rows = await db.select<{ seq: number; json: string }>(
        `SELECT seq, json FROM transcript
         WHERE machine_pubkey = ? AND session_id = ? AND seq >= ? AND seq <= ?
         ORDER BY seq ASC`,
        [machine, session, from, to],
      );
      const out: TranscriptEntryRow[] = [];
      for (const row of rows) {
        try {
          out.push({ seq: Number(row.seq), entry: JSON.parse(row.json) });
        } catch {
          // A corrupt row is unreadable, not fatal — skip it; sync re-fetches
          // the gap because haveRanges is computed from seqs, so drop it too.
          await db.execute(
            'DELETE FROM transcript WHERE machine_pubkey = ? AND session_id = ? AND seq = ?',
            [machine, session, row.seq],
          );
        }
      }
      return out;
    },

    remove: async (machine, session) => {
      await db.execute(
        'DELETE FROM transcript WHERE machine_pubkey = ? AND session_id = ?',
        [machine, session],
      );
    },
  };
}

// --- Prune (plan §5: last 5k entries/session, sessions idle > 30 days) ---

export const PRUNE_MAX_ENTRIES_PER_SESSION = 5_000;
export const PRUNE_IDLE_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PruneOptions {
  maxEntriesPerSession?: number;
  idleSessionMaxAgeMs?: number;
  now?: () => number;
}

export interface PruneResult {
  /** Sessions dropped entirely (idle beyond the age limit). */
  removedSessions: number;
  /** Rows trimmed from oversized sessions (oldest seqs first). */
  trimmedRows: number;
}

/** Callable prune — invoked at boot and on the daily tick (connectivity.ts). */
export async function pruneTranscripts(
  db: SqlExecutor,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const maxEntries = opts.maxEntriesPerSession ?? PRUNE_MAX_ENTRIES_PER_SESSION;
  const idleMaxAgeMs = opts.idleSessionMaxAgeMs ?? PRUNE_IDLE_SESSION_MAX_AGE_MS;
  const now = (opts.now ?? Date.now)();

  const result: PruneResult = { removedSessions: 0, trimmedRows: 0 };

  // 1) Drop sessions whose NEWEST row is older than the idle limit.
  const idle = await db.select<{ machine_pubkey: string; session_id: string }>(
    `SELECT machine_pubkey, session_id, MAX(created_at) AS newest
     FROM transcript
     GROUP BY machine_pubkey, session_id
     HAVING newest < ?`,
    [now - idleMaxAgeMs],
  );
  for (const row of idle) {
    await db.execute(
      'DELETE FROM transcript WHERE machine_pubkey = ? AND session_id = ?',
      [row.machine_pubkey, row.session_id],
    );
    result.removedSessions++;
  }

  // 2) Trim oversized sessions to their newest `maxEntries` seqs.
  const oversized = await db.select<{
    machine_pubkey: string;
    session_id: string;
    n: number;
  }>(
    `SELECT machine_pubkey, session_id, COUNT(*) AS n
     FROM transcript
     GROUP BY machine_pubkey, session_id
     HAVING n > ?`,
    [maxEntries],
  );
  for (const row of oversized) {
    const cutoff = await db.select<{ seq: number }>(
      `SELECT seq FROM transcript
       WHERE machine_pubkey = ? AND session_id = ?
       ORDER BY seq DESC
       LIMIT 1 OFFSET ?`,
      [row.machine_pubkey, row.session_id, maxEntries - 1],
    );
    const keepFrom = cutoff[0]?.seq;
    if (keepFrom === undefined) continue;
    await db.execute(
      'DELETE FROM transcript WHERE machine_pubkey = ? AND session_id = ? AND seq < ?',
      [row.machine_pubkey, row.session_id, keepFrom],
    );
    result.trimmedRows += Number(row.n) - maxEntries;
  }

  return result;
}
