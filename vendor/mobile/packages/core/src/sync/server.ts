/**
 * SyncServer — bridge side of the v10 transcript sync protocol.
 *
 * DELIBERATE REWRITE of the old history-request path, whose fire-and-forget
 * chunks (no retry, no ack) silently dropped history on flaky relays.
 *
 * Flow per sync-request {sessionId, haveRanges}:
 *   1. missing = missingRanges(haveRanges, 1, seqHigh)  (protocol ranges math)
 *   2. sync-begin {syncId, seqHigh, ranges: missing}
 *   3. one sync-chunk per chunkRanges(missing, 50), sent sequentially
 *   4. phone acks each chunk (handleAck); unacked chunks are retried up to
 *      2 times with backoff (10s, 20s, 40s)
 *   5. sync-end {deliveredRanges} reports ONLY acked ranges — honesty over
 *      completeness; the phone re-requests the difference on next connect.
 *
 * One active sync per (sessionId, phone); a newer sync-request for the same
 * key aborts and supersedes the old one (no sync-end for the loser). Syncs
 * with no activity for 60s are closed. Nothing here ever throws into the
 * caller — failures go to the injected log fn.
 */
import { randomUUID } from 'node:crypto';
import {
  chunkRanges,
  missingRanges,
  unionRanges,
  type BridgeToPhoneMessage,
  type SeqRange,
  type SyncRequestMessage,
} from '@codedeck/protocol';
import type { TranscriptStore } from '../session/transcript';

export const SYNC_CHUNK_SIZE = 50;
export const SYNC_ACK_TIMEOUT_MS = 10_000;
export const SYNC_IDLE_TIMEOUT_MS = 60_000;
export const SYNC_MAX_RETRIES = 2;

/** Injectable timer seam so tests control time without real waits. */
export interface SyncTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: SyncTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SyncServerOptions {
  transcript: TranscriptStore;
  /** Deliver one message to one phone (hex pubkey). Resolves false on publish failure. */
  send: (msg: BridgeToPhoneMessage, phone: string) => Promise<boolean>;
  log?: (msg: string) => void;
  chunkSize?: number;
  ackTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxRetries?: number;
  timers?: SyncTimers;
}

interface ChunkState {
  range: SeqRange;
  acked: boolean;
  sends: number;
}

interface SyncState {
  syncId: string;
  sessionId: string;
  phone: string;
  key: string;
  seqHigh: number;
  ranges: SeqRange[];
  chunks: ChunkState[];
  /** Send pass: 0 = initial, 1..maxRetries = retry passes. */
  pass: number;
  aborted: boolean;
  done: boolean;
  ackTimer?: unknown;
  idleTimer?: unknown;
}

export class SyncServer {
  private readonly transcript: TranscriptStore;
  private readonly send: (msg: BridgeToPhoneMessage, phone: string) => Promise<boolean>;
  private readonly logFn?: (msg: string) => void;
  private readonly chunkSize: number;
  private readonly ackTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly timers: SyncTimers;

  /** Active sync per (sessionId, phone). */
  private readonly byKey = new Map<string, SyncState>();
  /** Active sync per syncId (ack routing). */
  private readonly byId = new Map<string, SyncState>();

  constructor(options: SyncServerOptions) {
    this.transcript = options.transcript;
    this.send = options.send;
    this.logFn = options.log;
    this.chunkSize = options.chunkSize ?? SYNC_CHUNK_SIZE;
    this.ackTimeoutMs = options.ackTimeoutMs ?? SYNC_ACK_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? SYNC_IDLE_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? SYNC_MAX_RETRIES;
    this.timers = options.timers ?? realTimers;
  }

  /** Number of in-flight syncs (observability + tests). */
  activeSyncCount(): number {
    return this.byId.size;
  }

  /**
   * Handle a phone's sync-request. Supersedes any active sync for the same
   * (sessionId, phone). Never throws; the sync runs in the background.
   */
  handleSyncRequest(msg: SyncRequestMessage, phone: string): void {
    try {
      const key = `${msg.sessionId}\u0000${phone}`;
      const existing = this.byKey.get(key);
      if (existing) {
        this.log(`[Sync] ${existing.syncId}: superseded by new sync-request for ${msg.sessionId}`);
        this.abort(existing);
      }

      const seqHigh = this.transcript.seqHigh(msg.sessionId);
      const missing = missingRanges(msg.haveRanges, 1, seqHigh);
      const sync: SyncState = {
        syncId: randomUUID(),
        sessionId: msg.sessionId,
        phone,
        key,
        seqHigh,
        ranges: missing,
        chunks: chunkRanges(missing, this.chunkSize).map((range) => ({
          range,
          acked: false,
          sends: 0,
        })),
        pass: 0,
        aborted: false,
        done: false,
      };
      this.byKey.set(key, sync);
      this.byId.set(sync.syncId, sync);

      void this.run(sync).catch((err) => {
        this.log(`[Sync] ${sync.syncId}: failed: ${err}`);
        void this.finish(sync, 'error');
      });
    } catch (err) {
      this.log(`[Sync] handleSyncRequest failed: ${err}`);
    }
  }

  /** Handle a phone's sync-ack for one delivered chunk. Never throws. */
  handleAck(syncId: string, range: SeqRange): void {
    try {
      const sync = this.byId.get(syncId);
      if (!sync || sync.done || sync.aborted) { return; }
      const chunk = sync.chunks.find(
        (c) => c.range[0] === range[0] && c.range[1] === range[1],
      );
      if (!chunk) {
        this.log(`[Sync] ${syncId}: ack for unknown range [${range[0]},${range[1]}]`);
        return;
      }
      chunk.acked = true;
      this.touchIdle(sync);
      if (sync.chunks.every((c) => c.acked)) {
        void this.finish(sync, 'complete');
      }
    } catch (err) {
      this.log(`[Sync] handleAck failed: ${err}`);
    }
  }

  /** Abort all in-flight syncs (shutdown). */
  close(): void {
    for (const sync of [...this.byId.values()]) {
      this.abort(sync);
    }
  }

  private async run(sync: SyncState): Promise<void> {
    const ok = await this.send(
      {
        type: 'sync-begin',
        sessionId: sync.sessionId,
        syncId: sync.syncId,
        seqHigh: sync.seqHigh,
        ranges: sync.ranges,
      },
      sync.phone,
    );
    if (!ok) { this.log(`[Sync] ${sync.syncId}: sync-begin publish failed`); }
    if (sync.aborted || sync.done) { return; }
    this.touchIdle(sync);

    for (const chunk of sync.chunks) {
      if (sync.aborted || sync.done) { return; }
      await this.sendChunk(sync, chunk);
    }
    if (sync.aborted || sync.done) { return; }

    if (sync.chunks.every((c) => c.acked)) {
      // Nothing to deliver (or everything acked mid-send) — close immediately.
      await this.finish(sync, 'complete');
      return;
    }
    this.scheduleAckCheck(sync);
  }

  private async sendChunk(sync: SyncState, chunk: ChunkState): Promise<void> {
    const entries = await this.transcript.readRange(sync.sessionId, chunk.range);
    if (sync.aborted || sync.done) { return; }
    chunk.sends++;
    const ok = await this.send(
      {
        type: 'sync-chunk',
        sessionId: sync.sessionId,
        syncId: sync.syncId,
        range: chunk.range,
        entries,
      },
      sync.phone,
    );
    if (!ok) {
      this.log(
        `[Sync] ${sync.syncId}: chunk [${chunk.range[0]},${chunk.range[1]}] publish failed (send #${chunk.sends})`,
      );
    }
    this.touchIdle(sync);
  }

  private scheduleAckCheck(sync: SyncState): void {
    const delay = this.ackTimeoutMs * 2 ** sync.pass; // backoff: 10s, 20s, 40s
    sync.ackTimer = this.timers.set(() => {
      void this.onAckTimeout(sync).catch((err) => {
        this.log(`[Sync] ${sync.syncId}: retry pass failed: ${err}`);
        void this.finish(sync, 'error');
      });
    }, delay);
  }

  private async onAckTimeout(sync: SyncState): Promise<void> {
    if (sync.done || sync.aborted) { return; }
    const unacked = sync.chunks.filter((c) => !c.acked);
    if (unacked.length === 0) {
      await this.finish(sync, 'complete');
      return;
    }
    if (sync.pass >= this.maxRetries) {
      this.log(
        `[Sync] ${sync.syncId}: ${unacked.length} chunk(s) unacked after ${sync.pass} retries — reporting partial delivery`,
      );
      await this.finish(sync, 'retries-exhausted');
      return;
    }
    sync.pass++;
    this.log(`[Sync] ${sync.syncId}: retry pass ${sync.pass} for ${unacked.length} chunk(s)`);
    for (const chunk of unacked) {
      if (sync.aborted || sync.done) { return; }
      await this.sendChunk(sync, chunk);
    }
    if (!sync.aborted && !sync.done) {
      this.scheduleAckCheck(sync);
    }
  }

  /** Reset the idle clock on any activity (send or ack). */
  private touchIdle(sync: SyncState): void {
    if (sync.done || sync.aborted) { return; }
    if (sync.idleTimer !== undefined) { this.timers.clear(sync.idleTimer); }
    sync.idleTimer = this.timers.set(() => {
      if (sync.done || sync.aborted) { return; }
      this.log(`[Sync] ${sync.syncId}: idle for ${this.idleTimeoutMs}ms — closing`);
      void this.finish(sync, 'idle-timeout');
    }, this.idleTimeoutMs);
  }

  /**
   * Close a sync: clear timers, unregister, and send sync-end reporting ONLY
   * the acked ranges (honesty over completeness).
   */
  private async finish(sync: SyncState, reason: string): Promise<void> {
    if (sync.done || sync.aborted) { return; }
    sync.done = true;
    this.clearTimers(sync);
    this.unregister(sync);
    const delivered = unionRanges(
      sync.chunks.filter((c) => c.acked).map((c) => c.range),
      [],
    );
    try {
      const ok = await this.send(
        {
          type: 'sync-end',
          sessionId: sync.sessionId,
          syncId: sync.syncId,
          deliveredRanges: delivered,
        },
        sync.phone,
      );
      if (!ok) { this.log(`[Sync] ${sync.syncId}: sync-end publish failed (${reason})`); }
    } catch (err) {
      this.log(`[Sync] ${sync.syncId}: sync-end failed (${reason}): ${err}`);
    }
  }

  /** Abort without sync-end (superseded/shutdown — the phone re-requested anyway). */
  private abort(sync: SyncState): void {
    if (sync.done || sync.aborted) { return; }
    sync.aborted = true;
    this.clearTimers(sync);
    this.unregister(sync);
  }

  private clearTimers(sync: SyncState): void {
    if (sync.ackTimer !== undefined) {
      this.timers.clear(sync.ackTimer);
      sync.ackTimer = undefined;
    }
    if (sync.idleTimer !== undefined) {
      this.timers.clear(sync.idleTimer);
      sync.idleTimer = undefined;
    }
  }

  private unregister(sync: SyncState): void {
    this.byId.delete(sync.syncId);
    if (this.byKey.get(sync.key) === sync) {
      this.byKey.delete(sync.key);
    }
  }

  private log(msg: string): void {
    this.logFn?.(msg);
  }
}
