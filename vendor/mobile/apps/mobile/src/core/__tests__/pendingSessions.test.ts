/**
 * pendingSessionsStore — two-phase session creation slice (3c routing of the
 * previously validated-but-unrouted session-pending / session-failed).
 */
import { describe, it, expect } from 'vitest';
import {
  createPendingSessionsStore,
  PENDING_SWEEP_MS,
} from '../stores/pendingSessions';

const MACHINE = 'a'.repeat(64);

function make(startAt = 1_000_000) {
  let now = startAt;
  const store = createPendingSessionsStore({ now: () => now });
  return { store, advance: (ms: number) => { now += ms; } };
}

const pendingMsg = (id: string) => ({
  pendingId: id,
  machine: 'devbox (cli)',
  createdAt: '2026-08-05T00:00:00.000Z',
});

describe('pendingSessionsStore', () => {
  it('session-pending → optimistic placeholder for the machine', () => {
    const { store } = make();
    store.getState().applyPending(MACHINE, pendingMsg('p1'));
    const list = store.getState().pendingFor(MACHINE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      pendingId: 'p1',
      machine: MACHINE,
      machineName: 'devbox (cli)',
      state: 'pending',
    });
  });

  it('session-ready (resolve) removes the placeholder', () => {
    const { store } = make();
    store.getState().applyPending(MACHINE, pendingMsg('p1'));
    store.getState().resolve('p1');
    expect(store.getState().pendingFor(MACHINE)).toHaveLength(0);
    // resolving an unknown id is a no-op
    store.getState().resolve('nope');
  });

  it('session-failed flips the placeholder to a visible error with reason', () => {
    const { store } = make();
    store.getState().applyPending(MACHINE, pendingMsg('p1'));
    store.getState().applyFailed('p1', 'SDK session spawn failed');
    const [failed] = store.getState().pendingFor(MACHINE);
    expect(failed).toMatchObject({ state: 'failed', reason: 'SDK session spawn failed' });
  });

  it('a failure without a prior pending is still surfaced (never invisible)', () => {
    const { store } = make();
    store.getState().applyFailed('ghost', 'reason');
    const list = store.getState().pendingFor(MACHINE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pendingId: 'ghost', state: 'failed' });
  });

  it('dismiss removes a failed card; sweep drops only stale PENDING placeholders', () => {
    const { store, advance } = make();
    store.getState().applyPending(MACHINE, pendingMsg('p1'));
    store.getState().applyPending(MACHINE, pendingMsg('p2'));
    store.getState().applyFailed('p2', 'boom');

    advance(PENDING_SWEEP_MS + 1);
    store.getState().sweep();
    // stale pending p1 swept; failed p2 stays until the user dismisses it
    expect(store.getState().pendingFor(MACHINE).map((p) => p.pendingId)).toEqual(['p2']);

    store.getState().dismiss('p2');
    expect(store.getState().pendingFor(MACHINE)).toHaveLength(0);
  });

  it('a fresh pending survives the sweep', () => {
    const { store, advance } = make();
    store.getState().applyPending(MACHINE, pendingMsg('p1'));
    advance(PENDING_SWEEP_MS - 1000);
    store.getState().sweep();
    expect(store.getState().pendingFor(MACHINE)).toHaveLength(1);
  });
});
