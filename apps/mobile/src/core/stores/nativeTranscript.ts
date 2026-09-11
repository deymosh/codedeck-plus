/**
 * A native-backed `TranscriptStore` (migration F2b) — the one adapter backed
 * by an async, I/O-driven view (`TranscriptRowsView`, SQLite-on-device via
 * `TranscriptStore::read_range`) rather than a synchronous in-memory
 * snapshot every other adapter reads.
 *
 * Every WRITE method is a no-op: the Rust `Router` already applies every
 * `Output`/`SyncBegin`/`SyncChunk`/`SyncEnd`/`CloseSessionAck` bridge message
 * directly into the real, persistent `TranscriptStore` port, and already
 * runs its own sync-gap reconciliation on every session-list heartbeat
 * (`ensureSynced`'s whole job in TS). There is no ingest or sync-cycle path
 * left in TS to drive.
 *
 * `hydrateSession` is the one write-shaped method this adapter actually
 * implements: it is how a caller says "I want this session's transcript
 * resident" — `createPhoneCore.ts` calls it for every known session at
 * boot today, and this adapter keeps that same contract, fetching a fresh
 * `TranscriptRowsView` and caching it into `sessions`. After that, `session`/
 * `entriesOf`/`haveRangesOf`/`hasContiguous` are synchronous reads over the
 * cache, same as the TS store's own reads — correct as long as hydration
 * (or a `CoreEvent::TranscriptAppended` refresh) has already populated the
 * entry.
 *
 * `CoreEvent::TranscriptAppended { machine, sessionId }` re-fetches that
 * session unconditionally (not gated on "is it selected") — matching the
 * existing boot-time-hydrate-everything design, not a new eagerness this
 * adapter introduces.
 *
 * `seqConflicts` and `activeSyncId` have no production reader anywhere in
 * the UI (confirmed by search) — they stay `[]`/`null` rather than inventing
 * a Rust surface nothing needs yet. `hasContiguous` mirrors `transcript.ts`'s
 * own check (a single cached range starting at 1) rather than reaching for
 * a Rust equivalent, since it is a pure function of `haveRanges`, which is
 * already cached.
 */
import { createStore } from 'zustand/vanilla';
import { sessionKeyOf } from './ui';
import type { NativeCore } from '../../platform/nativeCore';
import type { TranscriptRowsView as NativeTranscriptRowsView } from '../nativeCoreTypes';
import type { SessionTranscript, TranscriptStore, TranscriptStoreState } from './transcript';

function toSessionTranscript(
  machine: string,
  sessionId: string,
  view: NativeTranscriptRowsView,
): SessionTranscript {
  const entries: SessionTranscript['entries'] = {};
  for (const row of view.rows) entries[row.seq] = row.entry;
  return {
    machine,
    sessionId,
    haveRanges: view.haveRanges,
    localHigh: view.sync.localHigh,
    entries,
    sync: {
      state: view.sync.state,
      attempts: view.sync.attempts,
      nextRetryAt: view.sync.nextRetryAt,
      activeSyncId: null,
      target: view.sync.target,
    },
  };
}

export interface NativeTranscriptStoreDeps {
  core: NativeCore;
  log?(msg: string): void;
}

export function createNativeTranscriptStore(deps: NativeTranscriptStoreDeps): TranscriptStore {
  const store = createStore<TranscriptStoreState>()((set, get) => {
    const fetchAndCache = async (machine: string, sessionId: string): Promise<void> => {
      try {
        const view = await deps.core.transcriptView(machine, sessionId);
        set({
          sessions: {
            ...get().sessions,
            [sessionKeyOf(machine, sessionId)]: toSessionTranscript(machine, sessionId, view),
          },
        });
      } catch (err) {
        deps.log?.(`[nativeTranscript] fetch failed for ${machine}/${sessionId}: ${err}`);
      }
    };

    void deps.core
      .onCoreEvent((event) => {
        if (typeof event === 'object' && 'transcriptAppended' in event) {
          const { machine, sessionId } = event.transcriptAppended;
          void fetchAndCache(machine, sessionId);
        }
      })
      .catch((err) => deps.log?.(`[nativeTranscript] onCoreEvent failed: ${err}`));

    const noopAsync = (): Promise<void> => Promise.resolve();

    return {
      sessions: {},
      seqConflicts: [],

      hydrateSession: fetchAndCache,
      applyOutput: noopAsync,
      applySyncBegin: noopAsync,
      applySyncChunk: noopAsync,
      applySyncEnd: noopAsync,
      ensureSynced: noopAsync,
      onReconnect: () => {},
      retrySweep: noopAsync,
      removeSession: noopAsync,

      session: (machine, sessionId) => get().sessions[sessionKeyOf(machine, sessionId)],
      haveRangesOf: (machine, sessionId) =>
        get().sessions[sessionKeyOf(machine, sessionId)]?.haveRanges ?? [],
      entriesOf: (machine, sessionId) => {
        const s = get().sessions[sessionKeyOf(machine, sessionId)];
        if (!s) return [];
        return Object.entries(s.entries)
          .map(([seq, entry]) => ({ seq: Number(seq), entry }))
          .sort((a, b) => a.seq - b.seq);
      },
      // Same "single range starting at 1" check transcript.ts's own
      // hasContiguous runs, over the cached haveRanges — a session not yet
      // fetched has no ranges, same as a genuinely-empty one.
      hasContiguous: (machine, sessionId, expectedHigh) => {
        const ranges = get().sessions[sessionKeyOf(machine, sessionId)]?.haveRanges ?? [];
        if (ranges.length === 0) return expectedHigh === undefined || expectedHigh === 0;
        if (ranges.length !== 1 || ranges[0]![0] !== 1) return false;
        return expectedHigh === undefined || ranges[0]![1] === expectedHigh;
      },
      flush: () => Promise.resolve(),
    };
  });

  return store;
}
