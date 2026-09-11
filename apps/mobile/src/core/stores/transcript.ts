/**
 * Transcript types shared by the native adapter (`nativeTranscript.ts`) and
 * the UI (`coreContext.tsx`).
 *
 * Row persistence (INSERT-OR-IGNORE dedup on (machine, session, seq)), the
 * sync client (haveRanges/missingRanges, bounded retry backoff, seq-conflict
 * detection), and the write queue are Rust's job now
 * (`client_core::stores::transcript`, `client_runtime`'s I/O-backed
 * `TranscriptRowsView`) — only the shared TYPES survive here.
 */
import type { StoreApi } from 'zustand/vanilla';
import type {
  OutputEntry,
  SeqRange,
  SyncBeginMessage,
  SyncChunkMessage,
  SyncEndMessage,
} from '@codedeck/protocol';

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
  /** In-memory entry cache for the UI. */
  entries: Record<number, OutputEntry>;
  sync: SessionSyncStatus;
}

export interface SeqConflict {
  machine: string;
  sessionId: string;
  seq: number;
}

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
