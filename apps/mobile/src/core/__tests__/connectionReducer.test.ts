/**
 * Connection FSM reducer — the bug-A design guarantees, unit-tested pure:
 * visibility flips never tear down a healthy socket, backoff/jitter bounds,
 * reconnect storms converge, decrypt failures are diagnostics not disconnects,
 * presence is an honest f(30515 age, socket state).
 */
import { describe, it, expect } from 'vitest';
import { ManualTimers } from '@codedeck/testkit';
import {
  DECRYPT_FAILURE_THRESHOLD,
  HEARTBEAT_STALE_AFTER_MS,
  RECONNECT_BASE_MS,
  RECONNECT_JITTER_FRACTION,
  RECONNECT_MAX_MS,
  VISIBILITY_DEBOUNCE_MS,
  backoffDelayMs,
  connectionReducer,
  createConnectionStore,
  heartbeatsAllStale,
  initialConnectionState,
  presenceOf,
  type ConnectionEffect,
  type ConnectionEvent,
  type ConnectionState,
} from '../stores/connection';

const reduce = (state: ConnectionState, ...events: ConnectionEvent[]) => {
  let s = state;
  const effects: ConnectionEffect[] = [];
  for (const event of events) {
    const r = connectionReducer(s, event);
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
};

const has = (effects: ConnectionEffect[], name: ConnectionEffect['effect']) =>
  effects.some((e) => e.effect === name);

const connectedState = (): ConnectionState =>
  reduce(initialConnectionState, { type: 'connect-requested' }, { type: 'socket-open', at: 1000 }).state;

describe('connectionReducer — basic lifecycle', () => {
  it('connect-requested opens the socket; socket-open lands in connected and reconciles', () => {
    const r1 = connectionReducer(initialConnectionState, { type: 'connect-requested' });
    expect(r1.state.status).toBe('connecting');
    expect(has(r1.effects, 'open-socket')).toBe(true);

    const r2 = connectionReducer(r1.state, { type: 'socket-open', at: 42 });
    expect(r2.state.status).toBe('connected');
    expect(r2.state.attempt).toBe(0);
    expect(r2.state.lastConnectedAt).toBe(42);
    expect(has(r2.effects, 'refresh-and-reconcile')).toBe(true);
  });

  it('connect-requested while already connected/connecting is a no-op', () => {
    const state = connectedState();
    expect(connectionReducer(state, { type: 'connect-requested' }).effects).toEqual([]);
  });

  it('disconnect-requested stops everything and stays inert', () => {
    const r = connectionReducer(connectedState(), { type: 'disconnect-requested' });
    expect(r.state.status).toBe('stopped');
    expect(has(r.effects, 'close-socket')).toBe(true);
    // Socket-close from our own teardown must not schedule anything.
    const r2 = connectionReducer(r.state, { type: 'socket-close' });
    expect(r2.effects).toEqual([]);
    expect(r2.state.status).toBe('stopped');
  });
});

describe('connectionReducer — backoff + jitter bounds', () => {
  it('exponential base with 30s cap', () => {
    expect(backoffDelayMs(0)).toBe(RECONNECT_BASE_MS);
    expect(backoffDelayMs(1)).toBe(4_000);
    expect(backoffDelayMs(2)).toBe(8_000);
    expect(backoffDelayMs(3)).toBe(16_000);
    expect(backoffDelayMs(4)).toBe(RECONNECT_MAX_MS);
    expect(backoffDelayMs(50)).toBe(RECONNECT_MAX_MS); // never overflows the cap
  });

  it('jitter adds at most +25% of the base, never negative', () => {
    for (const attempt of [0, 1, 2, 3, 4, 10]) {
      const base = backoffDelayMs(attempt, 0);
      expect(backoffDelayMs(attempt, 1)).toBeLessThanOrEqual(
        base + Math.floor(base * RECONNECT_JITTER_FRACTION),
      );
      expect(backoffDelayMs(attempt, 0.5)).toBeGreaterThanOrEqual(base);
      // Degenerate rng inputs stay in bounds.
      expect(backoffDelayMs(attempt, -5)).toBe(base);
      expect(backoffDelayMs(attempt, 99)).toBe(base + Math.floor(base * RECONNECT_JITTER_FRACTION));
    }
  });

  it('a reconnect storm backs off monotonically and converges at the cap', () => {
    let state = connectedState();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const closed = connectionReducer(state, { type: 'socket-close', random: 0 });
      const retry = closed.effects.find((e) => e.effect === 'schedule-retry');
      expect(retry).toBeDefined();
      delays.push((retry as { effect: 'schedule-retry'; delayMs: number }).delayMs);
      const due = connectionReducer(closed.state, { type: 'retry-due' });
      expect(due.state.status).toBe('connecting');
      state = due.state; // next close, without an intervening open — attempt keeps climbing
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000]);
    // One successful open resets the ladder.
    const opened = connectionReducer(state, { type: 'socket-open', at: 1 });
    expect(opened.state.attempt).toBe(0);
  });

  it('retry-due while offline or not waiting does nothing', () => {
    expect(connectionReducer(initialConnectionState, { type: 'retry-due' }).effects).toEqual([]);
    const closed = connectionReducer(connectedState(), { type: 'socket-close', random: 0 }).state;
    const offline = connectionReducer(closed, { type: 'offline' }).state;
    expect(connectionReducer(offline, { type: 'retry-due' }).effects).toEqual([]);
  });
});

describe('connectionReducer — network transitions', () => {
  it('offline closes the socket and cancels retries; online reconnects with a fresh backoff', () => {
    const offline = connectionReducer(connectedState(), { type: 'offline' });
    expect(offline.state.status).toBe('offline');
    expect(has(offline.effects, 'close-socket')).toBe(true);
    expect(has(offline.effects, 'cancel-retry')).toBe(true);

    const online = connectionReducer(offline.state, { type: 'online' });
    expect(online.state.status).toBe('connecting');
    expect(online.state.attempt).toBe(0);
    expect(has(online.effects, 'open-socket')).toBe(true);
  });

  it('socket-close while the OS says offline waits for online instead of burning retries', () => {
    let state = connectedState();
    state = { ...state, online: false }; // OS event raced the socket close
    const r = connectionReducer(state, { type: 'socket-close' });
    expect(r.state.status).toBe('offline');
    expect(has(r.effects, 'schedule-retry')).toBe(false);
  });

  it('online while connected is a no-op (never tears down a healthy socket)', () => {
    const r = connectionReducer(connectedState(), { type: 'online' });
    expect(r.effects).toEqual([]);
    expect(r.state.status).toBe('connected');
  });
});

describe('connectionReducer — visibility (debounced, never destructive)', () => {
  it('going hidden only schedules the 500ms debounce — the socket stays up', () => {
    const r = connectionReducer(connectedState(), { type: 'visibility', visible: false });
    expect(r.state.status).toBe('connected');
    expect(r.effects).toEqual([
      { effect: 'schedule-visibility-check', delayMs: VISIBILITY_DEBOUNCE_MS },
    ]);
  });

  it('hidden-then-visible within the debounce cancels cleanly, zero socket effects', () => {
    const { state, effects } = reduce(
      connectedState(),
      { type: 'visibility', visible: false },
      { type: 'visibility', visible: true },
    );
    expect(state.status).toBe('connected');
    expect(state.hiddenPending).toBe(false);
    expect(has(effects, 'close-socket')).toBe(false);
    expect(has(effects, 'open-socket')).toBe(false);
  });

  it('even a settled hide never tears down a healthy socket', () => {
    const { state, effects } = reduce(
      connectedState(),
      { type: 'visibility', visible: false },
      { type: 'visibility-settled' },
    );
    expect(state.status).toBe('connected');
    expect(state.visible).toBe(false);
    expect(has(effects, 'close-socket')).toBe(false);
  });

  it('a visibility flip storm produces no socket churn at all', () => {
    let state = connectedState();
    const all: ConnectionEffect[] = [];
    for (let i = 0; i < 20; i++) {
      const r = connectionReducer(state, { type: 'visibility', visible: i % 2 === 0 ? false : true });
      state = r.state;
      all.push(...r.effects);
    }
    expect(state.status).toBe('connected');
    expect(all.filter((e) => e.effect === 'close-socket' || e.effect === 'open-socket')).toEqual([]);
  });

  it('becoming visible with a dead connection reconnects immediately', () => {
    const closed = connectionReducer(connectedState(), { type: 'socket-close', random: 0 }).state;
    const r = connectionReducer(closed, { type: 'visibility', visible: true });
    expect(r.state.status).toBe('connecting');
    expect(has(r.effects, 'open-socket')).toBe(true);
    expect(has(r.effects, 'cancel-retry')).toBe(true);
  });
});

describe('connectionReducer — resume', () => {
  it('resume while connected = cheap refresh+reconcile, no socket churn', () => {
    const r = connectionReducer(connectedState(), { type: 'resume' });
    expect(r.state.status).toBe('connected');
    expect(r.effects).toEqual([{ effect: 'refresh-and-reconcile' }]);
  });

  it('resume with a dead connection reconnects with a fresh backoff', () => {
    const closed = connectionReducer(connectedState(), { type: 'socket-close', random: 0 }).state;
    const r = connectionReducer(closed, { type: 'resume' });
    expect(r.state.status).toBe('connecting');
    expect(r.state.attempt).toBe(0);
    expect(has(r.effects, 'open-socket')).toBe(true);
  });

  it('resume while offline or stopped stays put', () => {
    const offline = connectionReducer(connectedState(), { type: 'offline' }).state;
    expect(connectionReducer(offline, { type: 'resume' }).effects).toEqual([]);
    const stopped = connectionReducer(connectedState(), { type: 'disconnect-requested' }).state;
    expect(connectionReducer(stopped, { type: 'resume' }).effects).toEqual([]);
  });
});

describe('connectionReducer — decrypt failures are diagnostics, never disconnects', () => {
  it('counts failures and raises needsPairingCheck at the threshold', () => {
    let state = connectedState();
    for (let i = 1; i <= DECRYPT_FAILURE_THRESHOLD + 2; i++) {
      const r = connectionReducer(state, { type: 'decrypt-failure' });
      expect(r.effects).toEqual([]); // never any socket effect
      state = r.state;
      expect(state.status).toBe('connected'); // connection untouched
      expect(state.decryptFailures).toBe(i);
      expect(state.needsPairingCheck).toBe(i >= DECRYPT_FAILURE_THRESHOLD);
    }
  });
});

describe('presenceOf — 3 honest states', () => {
  it('socket down → offline regardless of heartbeat age', () => {
    let state = connectedState();
    state = connectionReducer(state, { type: 'heartbeat-received', machine: 'm1', at: 1000 }).state;
    const closed = connectionReducer(state, { type: 'socket-close', random: 0 }).state;
    expect(presenceOf(closed, 'm1', 1001)).toBe('offline');
  });

  it('fresh heartbeat → live; old heartbeat → stale; never seen → offline', () => {
    let state = connectedState();
    state = connectionReducer(state, { type: 'heartbeat-received', machine: 'm1', at: 1000 }).state;
    expect(presenceOf(state, 'm1', 1000 + HEARTBEAT_STALE_AFTER_MS)).toBe('live');
    expect(presenceOf(state, 'm1', 1001 + HEARTBEAT_STALE_AFTER_MS)).toBe('stale');
    expect(presenceOf(state, 'unknown', 1000)).toBe('offline');
  });
});

describe('createConnectionStore — effect interpreter on manual timers', () => {
  function harness() {
    const timers = new ManualTimers();
    const calls: string[] = [];
    const store = createConnectionStore({
      timers,
      now: () => 0,
      random: () => 0,
      handlers: {
        openSocket: () => calls.push('open'),
        closeSocket: () => calls.push('close'),
        refreshAndReconcile: () => calls.push('reconcile'),
      },
    });
    return { timers, calls, store, dispatch: (e: ConnectionEvent) => store.getState().dispatch(e) };
  }

  it('drives open → close → scheduled retry → reopen on virtual time', () => {
    const { timers, calls, store, dispatch } = harness();
    dispatch({ type: 'connect-requested' });
    expect(calls).toEqual(['open']);
    dispatch({ type: 'socket-open', at: 0 });
    expect(calls).toEqual(['open', 'reconcile']);

    dispatch({ type: 'socket-close', random: 0 });
    expect(store.getState().status).toBe('waiting-retry');
    expect(timers.pendingCount()).toBe(1);
    timers.advance(RECONNECT_BASE_MS);
    expect(store.getState().status).toBe('connecting');
    expect(calls).toEqual(['open', 'reconcile', 'open']);
  });

  it('visibility debounce timer settles without touching the socket', () => {
    const { timers, calls, store, dispatch } = harness();
    dispatch({ type: 'connect-requested' });
    dispatch({ type: 'socket-open', at: 0 });
    dispatch({ type: 'visibility', visible: false });
    expect(timers.pendingCount()).toBe(1);
    timers.advance(VISIBILITY_DEBOUNCE_MS);
    expect(store.getState().visible).toBe(false);
    expect(store.getState().status).toBe('connected');
    expect(calls.filter((c) => c === 'close')).toEqual([]);
  });

  it('a cancelled retry never fires (offline before the timer elapses)', () => {
    const { timers, calls, dispatch } = harness();
    dispatch({ type: 'connect-requested' });
    dispatch({ type: 'socket-open', at: 0 });
    dispatch({ type: 'socket-close', random: 0 });
    dispatch({ type: 'offline' });
    timers.advance(60_000);
    expect(calls.filter((c) => c === 'open').length).toBe(1); // only the initial one
  });
});

describe('heartbeatsAllStale + checkHeartbeats — dead-subscription detection (CDX-020)', () => {
  const STALE = HEARTBEAT_STALE_AFTER_MS;

  /** connected at t=0 with one machine heartbeat at t=0. */
  const connectedWithBeat = (): ConnectionState =>
    reduce(
      initialConnectionState,
      { type: 'connect-requested' },
      { type: 'socket-open', at: 0 },
      { type: 'heartbeat-received', machine: 'm1', at: 0 },
    ).state;

  it('pure: all heartbeats stale while connected past the grace window → true', () => {
    expect(heartbeatsAllStale(connectedWithBeat(), STALE + 1)).toBe(true);
  });

  it('pure: one fresh heartbeat keeps it false', () => {
    let state = connectedWithBeat();
    state = connectionReducer(state, { type: 'heartbeat-received', machine: 'm2', at: STALE }).state;
    expect(heartbeatsAllStale(state, STALE + 1)).toBe(false);
  });

  it('pure: no machine ever heartbeated this run → false (nothing to judge)', () => {
    const state = reduce(
      initialConnectionState,
      { type: 'connect-requested' },
      { type: 'socket-open', at: 0 },
    ).state;
    expect(heartbeatsAllStale(state, STALE * 10)).toBe(false);
  });

  it('pure: never true in any non-connected status, however old the beats', () => {
    const base = connectedWithBeat();
    const closed = connectionReducer(base, { type: 'socket-close', random: 0 }).state; // waiting-retry
    const offline = connectionReducer(base, { type: 'offline' }).state;
    const stopped = connectionReducer(base, { type: 'disconnect-requested' }).state;
    for (const state of [initialConnectionState, closed, offline, stopped]) {
      expect(heartbeatsAllStale(state, STALE * 10)).toBe(false);
    }
  });

  it('pure: a fresh (re)connect gets a full stale window of grace (the loop guard)', () => {
    // Old heartbeats survive a reconnect unchanged — lastConnectedAt is what
    // resets the baseline, so a just-reopened socket is never judged.
    let state = connectedWithBeat();
    state = connectionReducer(state, { type: 'socket-close', random: 0 }).state;
    state = connectionReducer(state, { type: 'retry-due' }).state;
    state = connectionReducer(state, { type: 'socket-open', at: STALE + 5 }).state;
    expect(heartbeatsAllStale(state, STALE + 6)).toBe(false); // within grace
    expect(heartbeatsAllStale(state, 2 * STALE + 6)).toBe(true); // still nothing heard a window later
  });

  function harness() {
    const timers = new ManualTimers();
    const calls: string[] = [];
    let now = 0;
    const store = createConnectionStore({
      timers,
      now: () => now,
      random: () => 0,
      handlers: {
        openSocket: () => calls.push('open'),
        closeSocket: () => calls.push('close'),
        refreshAndReconcile: () => calls.push('reconcile'),
      },
    });
    return {
      timers,
      calls,
      store,
      setNow: (t: number) => { now = t; },
      dispatch: (e: ConnectionEvent) => store.getState().dispatch(e),
      check: () => store.getState().checkHeartbeats(),
    };
  }

  it('store: stale-all dispatches socket-close ONCE, then the normal retry path reopens', () => {
    const { timers, calls, store, setNow, dispatch, check } = harness();
    dispatch({ type: 'connect-requested' });
    dispatch({ type: 'socket-open', at: 0 });
    dispatch({ type: 'heartbeat-received', machine: 'm1', at: 0 });

    setNow(HEARTBEAT_STALE_AFTER_MS + 1);
    check();
    expect(store.getState().status).toBe('waiting-retry');
    expect(timers.pendingCount()).toBe(1);

    // A second sweep before the retry fires must not dispatch again (no loop).
    check();
    expect(store.getState().status).toBe('waiting-retry');
    expect(timers.pendingCount()).toBe(1);

    timers.advance(RECONNECT_BASE_MS);
    expect(store.getState().status).toBe('connecting');
    expect(calls).toEqual(['open', 'reconcile', 'open']);
  });

  it('store: a fresh heartbeat prevents the forced close', () => {
    const { store, setNow, dispatch, check } = harness();
    dispatch({ type: 'connect-requested' });
    dispatch({ type: 'socket-open', at: 0 });
    dispatch({ type: 'heartbeat-received', machine: 'm1', at: 0 });
    dispatch({ type: 'heartbeat-received', machine: 'm1', at: HEARTBEAT_STALE_AFTER_MS });

    setNow(HEARTBEAT_STALE_AFTER_MS + 1);
    check();
    expect(store.getState().status).toBe('connected');
  });

  it('store: after the forced reconnect, the reopened socket is not immediately re-closed', () => {
    const { timers, store, setNow, dispatch, check } = harness();
    dispatch({ type: 'connect-requested' });
    dispatch({ type: 'socket-open', at: 0 });
    dispatch({ type: 'heartbeat-received', machine: 'm1', at: 0 });

    setNow(HEARTBEAT_STALE_AFTER_MS + 1);
    check();
    timers.advance(RECONNECT_BASE_MS); // retry-due → connecting
    dispatch({ type: 'socket-open', at: HEARTBEAT_STALE_AFTER_MS + 1 + RECONNECT_BASE_MS });

    // Next sweep, heartbeats still old — the lastConnectedAt grace holds.
    setNow(HEARTBEAT_STALE_AFTER_MS + 2 + RECONNECT_BASE_MS);
    check();
    expect(store.getState().status).toBe('connected');
  });

  it('store: never dispatches in idle/offline/stopped, whatever the heartbeat ages', () => {
    const { store, setNow, dispatch, check } = harness();
    setNow(HEARTBEAT_STALE_AFTER_MS * 10);
    check(); // idle
    expect(store.getState().status).toBe('idle');

    dispatch({ type: 'connect-requested' });
    dispatch({ type: 'socket-open', at: 0 });
    dispatch({ type: 'heartbeat-received', machine: 'm1', at: 0 });
    dispatch({ type: 'offline' });
    check();
    expect(store.getState().status).toBe('offline');

    dispatch({ type: 'disconnect-requested' });
    check();
    expect(store.getState().status).toBe('stopped');
  });
});
