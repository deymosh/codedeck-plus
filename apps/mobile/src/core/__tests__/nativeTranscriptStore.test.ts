/**
 * nativeTranscriptStore — proves the adapter presents the SAME
 * `TranscriptStoreState` shape `createTranscriptStore` does: `hydrateSession`
 * fetches + caches a `TranscriptRowsView`, the synchronous reads
 * (`session`/`entriesOf`/`haveRangesOf`/`hasContiguous`) answer from that
 * cache, a `transcriptAppended` CoreEvent re-fetches the right session, and
 * every write-shaped mutator besides `hydrateSession` is an inert no-op.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativeTranscriptStore } from '../stores/nativeTranscript';
import type { CoreEvent, TranscriptRowsView } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';

const view1: TranscriptRowsView = {
  rows: [
    { seq: 1, entry: { entryType: 'text', content: 'hi', timestamp: 't' } as never },
    { seq: 2, entry: { entryType: 'text', content: 'there', timestamp: 't' } as never },
  ],
  haveRanges: [[1, 2]],
  sync: { state: 'idle', attempts: 0, nextRetryAt: null, localHigh: 2, target: 2, contiguous: true },
};

const emptyView: TranscriptRowsView = {
  rows: [],
  haveRanges: [],
  sync: { state: 'idle', attempts: 0, nextRetryAt: null, localHigh: 0, target: 0, contiguous: true },
};

function fakeCore() {
  const byKey = new Map<string, TranscriptRowsView>();
  let coreEventListener: ((e: CoreEvent) => void) | null = null;
  const transcriptView = vi.fn(
    async (machine: string, sessionId: string): Promise<TranscriptRowsView> =>
      byKey.get(`${machine} ${sessionId}`) ?? emptyView,
  );

  const core: NativeCore = {
    defaults: () => Promise.reject(new Error('unused')),
    init: () => Promise.reject(new Error('unused')),
    start: () => Promise.reject(new Error('unused')),
    stop: () => Promise.reject(new Error('unused')),
    pause: () => Promise.reject(new Error('unused')),
    resume: () => Promise.reject(new Error('unused')),
    setOnline: () => Promise.reject(new Error('unused')),
    setMachines: () => Promise.reject(new Error('unused')),
    setRelays: () => Promise.reject(new Error('unused')),
    connectionStatus: () => Promise.reject(new Error('unused')),
    onConnection: () => Promise.reject(new Error('unused')),
    onActionFailed: () => Promise.reject(new Error('unused')),
    onResume: () => Promise.resolve(() => {}),
    dispatch: () => Promise.reject(new Error('unused')),
    machinesView: () => Promise.reject(new Error('unused')),
    settingsView: () => Promise.reject(new Error('unused')),
    outboxView: () => Promise.reject(new Error('unused')),
    pairingView: () => Promise.reject(new Error('unused')),
    dmView: () => Promise.reject(new Error('unused')),
    marmotView: () => Promise.reject(new Error('unused')),
    quickPromptsView: () => Promise.reject(new Error('unused')),
    pendingSessionsView: () => Promise.reject(new Error('unused')),
    uiView: () => Promise.reject(new Error('unused')),
    transcriptView,
    onCoreEvent: vi.fn(async (cb: (e: CoreEvent) => void) => {
      coreEventListener = cb;
      return () => {
        coreEventListener = null;
      };
    }),
  };

  return {
    core,
    transcriptView,
    setView: (machine: string, sessionId: string, view: TranscriptRowsView) =>
      byKey.set(`${machine} ${sessionId}`, view),
    emitAppended: (machine: string, sessionId: string) =>
      coreEventListener?.({ transcriptAppended: { machine, sessionId } }),
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('createNativeTranscriptStore', () => {
  it('hydrateSession fetches and caches the session', async () => {
    const { core, setView } = fakeCore();
    setView('m1', 's1', view1);
    const store = createNativeTranscriptStore({ core });

    await store.getState().hydrateSession('m1', 's1');

    const session = store.getState().session('m1', 's1');
    expect(session?.localHigh).toBe(2);
    expect(session?.haveRanges).toEqual([[1, 2]]);
    expect(session?.entries[1]).toEqual(view1.rows[0]!.entry);
  });

  it('entriesOf returns entries ascending by seq', async () => {
    const { core, setView } = fakeCore();
    setView('m1', 's1', view1);
    const store = createNativeTranscriptStore({ core });
    await store.getState().hydrateSession('m1', 's1');

    expect(store.getState().entriesOf('m1', 's1')).toEqual([
      { seq: 1, entry: view1.rows[0]!.entry },
      { seq: 2, entry: view1.rows[1]!.entry },
    ]);
    expect(store.getState().entriesOf('m1', 'never-hydrated')).toEqual([]);
  });

  it('haveRangesOf and session() are empty/undefined before hydration', async () => {
    const { core } = fakeCore();
    const store = createNativeTranscriptStore({ core });

    expect(store.getState().session('m1', 's1')).toBeUndefined();
    expect(store.getState().haveRangesOf('m1', 's1')).toEqual([]);
  });

  it('hasContiguous mirrors the single-range-from-1 check over cached haveRanges', async () => {
    const { core, setView } = fakeCore();
    setView('m1', 's1', view1);
    setView('m1', 's2', { ...view1, haveRanges: [[1, 1], [3, 4]] });
    const store = createNativeTranscriptStore({ core });
    await store.getState().hydrateSession('m1', 's1');
    await store.getState().hydrateSession('m1', 's2');

    expect(store.getState().hasContiguous('m1', 's1')).toBe(true);
    expect(store.getState().hasContiguous('m1', 's1', 2)).toBe(true);
    expect(store.getState().hasContiguous('m1', 's1', 5)).toBe(false);
    expect(store.getState().hasContiguous('m1', 's2')).toBe(false);
    // Never hydrated — vacuously contiguous unless a specific high is expected.
    expect(store.getState().hasContiguous('m1', 'never-hydrated')).toBe(true);
    expect(store.getState().hasContiguous('m1', 'never-hydrated', 3)).toBe(false);
  });

  it('a transcriptAppended CoreEvent re-fetches that exact session', async () => {
    const { core, setView, emitAppended, transcriptView } = fakeCore();
    const store = createNativeTranscriptStore({ core });
    await tick();

    setView('m1', 's1', view1);
    emitAppended('m1', 's1');
    await tick();

    expect(transcriptView).toHaveBeenCalledWith('m1', 's1');
    expect(store.getState().session('m1', 's1')?.localHigh).toBe(2);
  });

  it('ensureSynced/retrySweep/flush are inert no-ops — Rust runs its own sync reconciliation', async () => {
    const { core, transcriptView } = fakeCore();
    const store = createNativeTranscriptStore({ core });
    await tick();
    transcriptView.mockClear();

    const s = store.getState();
    await s.ensureSynced('m1', 's1', 10);
    await s.retrySweep();
    await s.flush();

    expect(transcriptView).not.toHaveBeenCalled();
    expect(store.getState().session('m1', 's1')).toBeUndefined();
    expect(store.getState().seqConflicts).toEqual([]);
  });
});
