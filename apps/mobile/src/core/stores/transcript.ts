/**
 * transcriptStore — per-session transcript persistence + the sync client.
 *
 * Kills bug B ("session history gets lost") by design:
 * - Every entry goes through an async storage port with INSERT OR IGNORE
 *   semantics on (machine, session, seq) — dedup is structural, and Phase 3b
 *   swaps the in-memory port for SQLite without touching this store.
 * - `haveRanges` is computed from what is actually stored (via
 *   @codedeck/protocol's range math) — sync requests carry the truth, so gaps
 *   from missed ephemeral output are exactly what gets re-delivered.
 * - Per-session sync status with bounded attempts + exponential retry backoff
 *   REPLACES the old never-reset `autoHistoryRequested` Set: a failed sync
 *   retries after a backoff, and `onReconnect()` resets every cycle so a fresh
 *   connection always gets a fresh chance. One failed fetch can no longer
 *   blank a session forever.
 * - A seq arriving twice with different content is recorded in `seqConflicts`
 *   (bridge-side renumbering — forbidden by the contract) and NOT applied.
 *
 * All mutations run on one internal write queue so storage writes and the
 * reads that feed sync-requests never interleave; `flush()` awaits it (tests).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  missingRanges,
  normalizeRanges,
  unionRanges,
  type OutputEntry,
  type SeqRange,
  type SyncBeginMessage,
  type SyncChunkMessage,
  type SyncEndMessage,
  type PhoneToBridgeMessage,
} from '@codedeck/protocol';
import type { Logger, TranscriptStorage } from '../ports';

export type SyncState = 'idle' | 'requested' | 'syncing' | 'complete' | 'failed';

export interface SessionSyncStatus {
  state: SyncState;
  /** sync-requests sent in the current cycle (reset on success/reconnect). */
  attempts: number;
  /** When state === 'failed': earliest ms timestamp a retry may fire. */
  nextRetryAt: number | null;
  activeSyncId: string | null;
  /** seqHigh we are trying to cover (from the session list / sync-begin). */
  target: number;
}

export interface SessionTranscript {
  machine: string;
  sessionId: string;
  haveRanges: SeqRange[];
  /** Highest locally-stored seq (0 = empty). */
  localHigh: number;
  /** In-memory entry cache for the UI (3b: replaced by SQLite range reads). */
  entries: Record<number, OutputEntry>;
  sync: SessionSyncStatus;
}

export interface SeqConflict {
  machine: string;
  sessionId: string;
  seq: number;
}

export const SYNC_MAX_ATTEMPTS = 3;
export const SYNC_RETRY_BASE_MS = 5_000;
export const SYNC_RETRY_MAX_MS = 300_000;

/** Retry backoff after a failed sync cycle: 5s → 5min cap, exponential. */
export function syncRetryDelayMs(attempts: number): number {
  return Math.min(SYNC_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)), SYNC_RETRY_MAX_MS);
}

const emptySync = (): SessionSyncStatus => ({
  state: 'idle',
  attempts: 0,
  nextRetryAt: null,
  activeSyncId: null,
  target: 0,
});

const keyOf = (machine: string, sessionId: string): string => `${machine} ${sessionId}`;

export interface TranscriptStoreState {
  sessions: Record<string, SessionTranscript>;
  /** Diagnostics: forbidden bridge-side renumbering observations. */
  seqConflicts: SeqConflict[];

  /** Load persisted seqs for a session (boot / first selection). */
  hydrateSession(machine: string, sessionId: string): Promise<void>;
  /** Live 24515 output. */
  applyOutput(machine: string, sessionId: string, seq: number, entry: OutputEntry): Promise<void>;
  applySyncBegin(machine: string, msg: SyncBeginMessage): Promise<void>;
  applySyncChunk(machine: string, msg: SyncChunkMessage): Promise<void>;
  applySyncEnd(machine: string, msg: SyncEndMessage): Promise<void>;
  /**
   * Reconcile toward `targetSeqHigh` (from the session list): when gaps exist
   * and no sync is in flight (and any failure backoff has elapsed), send a
   * sync-request carrying the real haveRanges.
   */
  ensureSynced(machine: string, sessionId: string, targetSeqHigh: number): Promise<void>;
  /** Reset sync cycles (failed/stuck → idle, attempts 0) — called on every
   *  reconnect so no failure is ever permanent. */
  onReconnect(machine?: string): void;
  /** Fire retries whose backoff has elapsed. */
  retrySweep(): Promise<void>;
  /** Explicit removal (tombstone / user delete) — drops persisted rows too. */
  removeSession(machine: string, sessionId: string): Promise<void>;

  session(machine: string, sessionId: string): SessionTranscript | undefined;
  haveRangesOf(machine: string, sessionId: string): SeqRange[];
  entriesOf(machine: string, sessionId: string): Array<{ seq: number; entry: OutputEntry }>;
  hasContiguous(machine: string, sessionId: string, expectedHigh?: number): boolean;
  /** Await all queued writes (tests / shutdown). */
  flush(): Promise<void>;
}

export type TranscriptStore = StoreApi<TranscriptStoreState>;

export interface TranscriptStoreDeps {
  storage: TranscriptStorage;
  /** Send one phone→bridge message (sync-request / sync-ack). */
  send(machine: string, msg: PhoneToBridgeMessage): void;
  now(): number;
  maxAttempts?: number;
  log?: Logger;
}

export function createTranscriptStore(deps: TranscriptStoreDeps): TranscriptStore {
  const maxAttempts = deps.maxAttempts ?? SYNC_MAX_ATTEMPTS;
  let queue: Promise<void> = Promise.resolve();

  const store = createStore<TranscriptStoreState>()((set, get) => {
    const enqueue = (work: () => Promise<void>): Promise<void> => {
      queue = queue.then(work).catch((err) => {
        deps.log?.(`[Transcript] queued write failed: ${err}`);
      });
      return queue;
    };

    const getOrCreate = (machine: string, sessionId: string): SessionTranscript => {
      const key = keyOf(machine, sessionId);
      const existing = get().sessions[key];
      if (existing) return existing;
      const fresh: SessionTranscript = {
        machine,
        sessionId,
        haveRanges: [],
        localHigh: 0,
        entries: {},
        sync: emptySync(),
      };
      set({ sessions: { ...get().sessions, [key]: fresh } });
      return fresh;
    };

    const patchSession = (
      machine: string,
      sessionId: string,
      patch: (s: SessionTranscript) => SessionTranscript,
    ): void => {
      const key = keyOf(machine, sessionId);
      const current = get().sessions[key] ?? getOrCreate(machine, sessionId);
      set({ sessions: { ...get().sessions, [key]: patch(current) } });
    };

    /** Insert rows through the port; update ranges/cache; record conflicts. */
    const applyRows = async (
      machine: string,
      sessionId: string,
      rows: Array<{ seq: number; entry: OutputEntry }>,
    ): Promise<void> => {
      if (rows.length === 0) return;
      getOrCreate(machine, sessionId);
      const inserted = new Set(
        await deps.storage.insertIgnore(machine, sessionId, rows),
      );
      const conflicts: SeqConflict[] = [];
      patchSession(machine, sessionId, (s) => {
        const entries = { ...s.entries };
        for (const { seq, entry } of rows) {
          if (inserted.has(seq)) {
            entries[seq] = entry;
            continue;
          }
          // Already stored: same seq must mean same content — anything else is
          // renumbering, which we record and refuse to apply.
          const existing = entries[seq];
          if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) {
            conflicts.push({ machine, sessionId, seq });
          }
        }
        const haveRanges = unionRanges(
          s.haveRanges,
          [...inserted].map((seq): SeqRange => [seq, seq]),
        );
        const localHigh = haveRanges.length > 0 ? haveRanges[haveRanges.length - 1]![1] : 0;
        return { ...s, entries, haveRanges, localHigh };
      });
      if (conflicts.length > 0) {
        set({ seqConflicts: [...get().seqConflicts, ...conflicts] });
        deps.log?.(`[Transcript] seq conflict(s) for ${sessionId}: ${conflicts.map((c) => c.seq).join(', ')}`);
      }
    };

    const sendSyncRequest = (machine: string, sessionId: string): void => {
      const s = get().sessions[keyOf(machine, sessionId)];
      const haveRanges = s ? s.haveRanges : [];
      deps.send(machine, { type: 'sync-request', sessionId, haveRanges });
    };

    const startCycle = (machine: string, sessionId: string, target: number): void => {
      patchSession(machine, sessionId, (s) => ({
        ...s,
        sync: {
          ...s.sync,
          state: 'requested',
          attempts: s.sync.attempts + 1,
          nextRetryAt: null,
          activeSyncId: null,
          target: Math.max(target, s.sync.target),
        },
      }));
      sendSyncRequest(machine, sessionId);
    };

    return {
      sessions: {},
      seqConflicts: [],

      hydrateSession: (machine, sessionId) =>
        enqueue(async () => {
          const seqs = await deps.storage.seqs(machine, sessionId);
          const rows = seqs.length > 0
            ? await deps.storage.readRange(machine, sessionId, seqs[0]!, seqs[seqs.length - 1]!)
            : [];
          patchSession(machine, sessionId, (s) => {
            const haveRanges = normalizeRanges(seqs.map((seq): SeqRange => [seq, seq]));
            const entries = { ...s.entries };
            for (const { seq, entry } of rows) entries[seq] = entry as OutputEntry;
            return {
              ...s,
              haveRanges,
              localHigh: haveRanges.length > 0 ? haveRanges[haveRanges.length - 1]![1] : 0,
              entries,
            };
          });
        }),

      applyOutput: (machine, sessionId, seq, entry) =>
        enqueue(() => applyRows(machine, sessionId, [{ seq, entry }])),

      applySyncBegin: (machine, msg) =>
        enqueue(async () => {
          patchSession(machine, msg.sessionId, (s) => ({
            ...s,
            sync: {
              ...s.sync,
              state: 'syncing',
              activeSyncId: msg.syncId,
              target: Math.max(s.sync.target, msg.seqHigh),
            },
          }));
        }),

      applySyncChunk: (machine, msg) =>
        enqueue(async () => {
          await applyRows(machine, msg.sessionId, msg.entries);
          // Ack AFTER the entries are durably stored — an ack must never claim
          // data we could still lose.
          deps.send(machine, { type: 'sync-ack', syncId: msg.syncId, range: msg.range });
        }),

      applySyncEnd: (machine, msg) =>
        enqueue(async () => {
          const key = keyOf(machine, msg.sessionId);
          const s = get().sessions[key];
          if (!s) return;
          const target = Math.max(s.sync.target, s.localHigh);
          const missing = target > 0 ? missingRanges(s.haveRanges, 1, target) : [];
          if (missing.length === 0) {
            patchSession(machine, msg.sessionId, (cur) => ({
              ...cur,
              sync: { ...cur.sync, state: 'complete', attempts: 0, nextRetryAt: null, activeSyncId: null },
            }));
            return;
          }
          if (s.sync.attempts < maxAttempts) {
            deps.log?.(`[Transcript] sync-end for ${msg.sessionId} left gaps ${JSON.stringify(missing)} — re-requesting`);
            startCycle(machine, msg.sessionId, target);
            return;
          }
          // Attempts exhausted: NOT permanent — a backoff timestamp, reset on
          // reconnect. (The old app's never-reset Set died here.)
          const delay = syncRetryDelayMs(s.sync.attempts);
          deps.log?.(`[Transcript] sync for ${msg.sessionId} failed after ${s.sync.attempts} attempts — retry in ${delay}ms`);
          patchSession(machine, msg.sessionId, (cur) => ({
            ...cur,
            sync: {
              ...cur.sync,
              state: 'failed',
              nextRetryAt: deps.now() + delay,
              activeSyncId: null,
            },
          }));
        }),

      ensureSynced: (machine, sessionId, targetSeqHigh) =>
        enqueue(async () => {
          if (targetSeqHigh <= 0) return;
          const s = getOrCreate(machine, sessionId);
          const missing = missingRanges(s.haveRanges, 1, targetSeqHigh);
          if (missing.length === 0) {
            if (s.sync.state !== 'complete') {
              patchSession(machine, sessionId, (cur) => ({
                ...cur,
                sync: { ...cur.sync, state: 'complete', attempts: 0, nextRetryAt: null, activeSyncId: null },
              }));
            }
            return;
          }
          if (s.sync.state === 'requested' || s.sync.state === 'syncing') {
            // In flight — just raise the target; sync-end reconciles the rest.
            patchSession(machine, sessionId, (cur) => ({
              ...cur,
              sync: { ...cur.sync, target: Math.max(cur.sync.target, targetSeqHigh) },
            }));
            return;
          }
          if (s.sync.state === 'failed' && s.sync.nextRetryAt !== null && deps.now() < s.sync.nextRetryAt) {
            return; // backoff still running — retrySweep or reconnect will retry
          }
          startCycle(machine, sessionId, targetSeqHigh);
        }),

      onReconnect: (machine) => {
        const sessions = { ...get().sessions };
        for (const [key, s] of Object.entries(sessions)) {
          if (machine !== undefined && s.machine !== machine) continue;
          if (s.sync.state === 'idle' || s.sync.state === 'complete') continue;
          // A new connection is a new world: clear failures AND stuck in-flight
          // cycles (their responses may have been lost while disconnected).
          sessions[key] = {
            ...s,
            sync: { ...s.sync, state: 'idle', attempts: 0, nextRetryAt: null, activeSyncId: null },
          };
        }
        set({ sessions });
      },

      retrySweep: () =>
        enqueue(async () => {
          const now = deps.now();
          for (const s of Object.values(get().sessions)) {
            if (s.sync.state !== 'failed') continue;
            if (s.sync.nextRetryAt !== null && now < s.sync.nextRetryAt) continue;
            if (s.sync.target <= 0) continue;
            startCycle(s.machine, s.sessionId, s.sync.target);
          }
        }),

      removeSession: (machine, sessionId) =>
        enqueue(async () => {
          await deps.storage.remove(machine, sessionId);
          const sessions = { ...get().sessions };
          delete sessions[keyOf(machine, sessionId)];
          set({ sessions });
        }),

      session: (machine, sessionId) => get().sessions[keyOf(machine, sessionId)],
      haveRangesOf: (machine, sessionId) =>
        get().sessions[keyOf(machine, sessionId)]?.haveRanges ?? [],
      entriesOf: (machine, sessionId) => {
        const s = get().sessions[keyOf(machine, sessionId)];
        if (!s) return [];
        return Object.entries(s.entries)
          .map(([seq, entry]) => ({ seq: Number(seq), entry }))
          .sort((a, b) => a.seq - b.seq);
      },
      hasContiguous: (machine, sessionId, expectedHigh) => {
        const s = get().sessions[keyOf(machine, sessionId)];
        const ranges = s?.haveRanges ?? [];
        if (ranges.length === 0) return expectedHigh === undefined || expectedHigh === 0;
        if (ranges.length !== 1 || ranges[0]![0] !== 1) return false;
        return expectedHigh === undefined || ranges[0]![1] === expectedHigh;
      },
      flush: () => queue,
    };
  });

  return store;
}
