/**
 * Exhaustive pinReducer tests — bug C's cure is this state machine, so it gets
 * property-style storms on top of the case-by-case suite. The core invariant
 * throughout: a scroll may only ever be requested while `pinned`, and nothing
 * but a user reaching/leaving the bottom (or a session switch) flips `pinned`.
 */
import { describe, it, expect } from 'vitest';
import {
  initialPinState,
  pinReducer,
  type PinEvent,
  type PinState,
} from '../pinReducer';

const run = (events: PinEvent[], from: PinState = initialPinState): PinState =>
  events.reduce(pinReducer, from);

describe('pinReducer — basics', () => {
  it('starts pinned at bottom', () => {
    expect(initialPinState).toMatchObject({ pinned: true, atBottom: true, missedEntries: 0 });
  });

  it('unflagged scroll away from bottom unpins', () => {
    const s = run([{ type: 'user-scroll', atBottom: false }]);
    expect(s.pinned).toBe(false);
    expect(s.atBottom).toBe(false);
  });

  it('unflagged scroll landing on the bottom re-pins and clears missed count', () => {
    const s = run([
      { type: 'user-scroll', atBottom: false },
      { type: 'new-entries', count: 3 },
      { type: 'user-scroll', atBottom: true },
    ]);
    expect(s.pinned).toBe(true);
    expect(s.missedEntries).toBe(0);
  });

  it('reached-bottom pins regardless of how the viewport got there', () => {
    const s = run([
      { type: 'user-scroll', atBottom: false },
      { type: 'new-entries', count: 5 },
      { type: 'reached-bottom' },
    ]);
    expect(s.pinned).toBe(true);
    expect(s.atBottom).toBe(true);
    expect(s.missedEntries).toBe(0);
  });

  it('left-bottom alone never unpins (content growth is not user intent)', () => {
    const s = run([{ type: 'left-bottom' }]);
    expect(s.pinned).toBe(true);
    expect(s.atBottom).toBe(false);
  });

  it('session-switch resets to pinned but NOT at bottom from any state (CDX-024)', () => {
    const s = run([
      { type: 'user-scroll', atBottom: false },
      { type: 'new-entries', count: 9 },
      { type: 'programmatic-scroll-start' },
      { type: 'session-switch' },
    ]);
    // atBottom must be false: the owner effect scrolls iff pinned && !atBottom,
    // so a reset asserting atBottom would leave a long session mid-history with
    // no jump pill — the initial scrollToBottom has to fire.
    expect(s).toEqual({ ...initialPinState, atBottom: false });
  });
});

describe('pinReducer — programmatic-scroll flagging', () => {
  it('flagged scrolls never unpin', () => {
    const s = run([
      { type: 'programmatic-scroll-start' },
      { type: 'user-scroll', atBottom: false }, // mid-flight: not at bottom yet
      { type: 'user-scroll', atBottom: true },
      { type: 'programmatic-scroll-end' },
    ]);
    expect(s.pinned).toBe(true);
  });

  it('an unflagged scroll after the window closes unpins normally', () => {
    const s = run([
      { type: 'programmatic-scroll-start' },
      { type: 'user-scroll', atBottom: true },
      { type: 'programmatic-scroll-end' },
      { type: 'user-scroll', atBottom: false },
    ]);
    expect(s.pinned).toBe(false);
  });

  it('nested flags: still flagged until every start is ended', () => {
    const mid = run([
      { type: 'programmatic-scroll-start' },
      { type: 'programmatic-scroll-start' },
      { type: 'programmatic-scroll-end' },
    ]);
    expect(mid.programmaticDepth).toBe(1);
    const s = pinReducer(mid, { type: 'user-scroll', atBottom: false });
    expect(s.pinned).toBe(true); // still flagged
  });

  it('programmatic depth clamps at 0 on stray ends (double-end is a no-op)', () => {
    const s = run([
      { type: 'programmatic-scroll-end' },
      { type: 'programmatic-scroll-end' },
    ]);
    expect(s.programmaticDepth).toBe(0);
    // and a user scroll now unpins — the stray ends did not corrupt anything
    expect(pinReducer(s, { type: 'user-scroll', atBottom: false }).pinned).toBe(false);
  });

  it('flagged scroll to bottom while pinned keeps missed count at 0', () => {
    const s = run([
      { type: 'programmatic-scroll-start' },
      { type: 'user-scroll', atBottom: true },
      { type: 'programmatic-scroll-end' },
    ]);
    expect(s.missedEntries).toBe(0);
    expect(s.atBottom).toBe(true);
  });
});

describe('pinReducer — new entries', () => {
  it('never changes pinned', () => {
    expect(run([{ type: 'new-entries', count: 4 }]).pinned).toBe(true);
    const unpinned = run([
      { type: 'user-scroll', atBottom: false },
      { type: 'new-entries', count: 4 },
    ]);
    expect(unpinned.pinned).toBe(false);
  });

  it('counts missed entries only while unpinned', () => {
    const pinnedState = run([{ type: 'new-entries', count: 4 }]);
    expect(pinnedState.missedEntries).toBe(0);

    const s = run([
      { type: 'user-scroll', atBottom: false },
      { type: 'new-entries', count: 4 },
      { type: 'new-entries', count: 2 },
    ]);
    expect(s.missedEntries).toBe(6);
  });

  it('negative counts are ignored', () => {
    const s = run([
      { type: 'user-scroll', atBottom: false },
      { type: 'new-entries', count: -5 },
    ]);
    expect(s.missedEntries).toBe(0);
  });
});

// --- Property-style storms ---

/** Deterministic PRNG (mulberry32) so failures are reproducible by seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEvent(rand: () => number): PinEvent {
  const roll = rand();
  if (roll < 0.35) return { type: 'user-scroll', atBottom: rand() < 0.4 };
  if (roll < 0.5) return { type: 'new-entries', count: 1 + Math.floor(rand() * 5) };
  if (roll < 0.62) return { type: 'programmatic-scroll-start' };
  if (roll < 0.74) return { type: 'programmatic-scroll-end' };
  if (roll < 0.84) return { type: 'reached-bottom' };
  if (roll < 0.94) return { type: 'left-bottom' };
  return { type: 'session-switch' };
}

describe('pinReducer — event storms (property-style)', () => {
  // 60k reducer steps: <1s alone, but worker contention in the full parallel
  // run can starve it past vitest's 5s default — give it explicit headroom.
  it('holds every invariant across 200 seeded random storms of 300 events', { timeout: 30_000 }, () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      let state = initialPinState;
      // Model of the ONE owner effect: it "scrolls" only when pinned. We track
      // whether a scroll could ever be requested while unpinned — it must not.
      for (let i = 0; i < 300; i++) {
        const event = randomEvent(rand);
        const before = state;
        state = pinReducer(state, event);
        const ctx = `seed ${seed} step ${i} event ${event.type}`;

        // Invariant: depth never negative.
        expect(state.programmaticDepth, ctx).toBeGreaterThanOrEqual(0);
        // Invariant: missed entries never negative.
        expect(state.missedEntries, ctx).toBeGreaterThanOrEqual(0);
        // Invariant 1: an unflagged user scroll away from bottom always unpins.
        if (event.type === 'user-scroll' && !event.atBottom && before.programmaticDepth === 0) {
          expect(state.pinned, ctx).toBe(false);
        }
        // Invariant 2: reaching the bottom always pins + clears missed.
        if (event.type === 'reached-bottom'
            || (event.type === 'user-scroll' && event.atBottom && before.programmaticDepth === 0)) {
          expect(state.pinned, ctx).toBe(true);
          expect(state.missedEntries, ctx).toBe(0);
        }
        // Invariant 3: session-switch fully resets — pinned, but atBottom
        // false so the owner effect's scrollToBottom fires (CDX-024).
        if (event.type === 'session-switch') {
          expect(state, ctx).toEqual({ ...initialPinState, atBottom: false });
        }
        // Invariant 4: new-entries never flips pinned; while unpinned it never
        // "requests a scroll" — encoded as: unpinned stays unpinned and only
        // missedEntries may change.
        if (event.type === 'new-entries') {
          expect(state.pinned, ctx).toBe(before.pinned);
          if (!before.pinned) {
            expect({ ...state, missedEntries: 0 }, ctx).toEqual({ ...before, missedEntries: 0 });
          }
        }
        // Invariant 5: flagged scrolls never unpin.
        if (event.type === 'user-scroll' && before.programmaticDepth > 0) {
          expect(state.pinned, ctx).toBe(before.pinned);
        }
        // Global: pinned may only become false via an unflagged user scroll.
        if (!before.pinned || state.pinned || event.type === 'session-switch') continue;
        expect(event.type, ctx).toBe('user-scroll');
        expect(before.programmaticDepth, ctx).toBe(0);
      }
    }
  });

  it('interleaved programmatic windows and user flings: pin state converges to the geometry', () => {
    for (let seed = 300; seed < 340; seed++) {
      const rand = rng(seed);
      let state = initialPinState;
      // storm ends with: user scrolls to bottom → must be pinned
      for (let i = 0; i < 100; i++) state = pinReducer(state, randomEvent(rand));
      while (state.programmaticDepth > 0) state = pinReducer(state, { type: 'programmatic-scroll-end' });
      state = pinReducer(state, { type: 'user-scroll', atBottom: true });
      expect(state.pinned).toBe(true);
      expect(state.missedEntries).toBe(0);
      // ...and a storm ending with a scroll-away must be unpinned
      state = pinReducer(state, { type: 'user-scroll', atBottom: false });
      expect(state.pinned).toBe(false);
    }
  });
});
