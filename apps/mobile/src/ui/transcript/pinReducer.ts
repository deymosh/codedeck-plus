/**
 * pinReducer — the ONE pure state machine behind transcript auto-scroll.
 *
 * Bug C ("scroll-up gets yanked down") existed because the old app had FOUR
 * competing auto-scroll drivers (new-entry timers, a ResizeObserver, the
 * react-window onResize handler, and session-switch timers), only some of
 * which checked the "user is interacting" guard. The cure is structural:
 * scrolling is owned by exactly one effect (useTranscriptPin) gated on the
 * `pinned` flag computed HERE, from an explicit event vocabulary:
 *
 * - `user-scroll`        an UNFLAGGED scroll observed on the viewport (touch,
 *                        wheel, scrollbar). Carries whether the viewport is at
 *                        the bottom after the scroll.
 * - `programmatic-scroll-start` / `programmatic-scroll-end`
 *                        the pin owner flags its own scrollToBottom calls so
 *                        the reducer can distinguish them: scrolls arriving
 *                        inside the window are the program's, never the user's.
 * - `reached-bottom` / `left-bottom`
 *                        pure geometry transitions (content growth can move
 *                        the viewport off the bottom without any scroll event).
 * - `new-entries`        entries appended to the transcript. NEVER scrolls by
 *                        itself — when pinned the owner effect scrolls; when
 *                        unpinned it only counts toward the jump-pill badge.
 * - `session-switch`     a different session is shown — full reset, pinned but
 *                        NOT atBottom, so the owner effect immediately scrolls
 *                        the fresh session to the live end (CDX-024).
 *
 * Invariants (unit-tested exhaustively in pinReducer.test.ts):
 * 1. Any unflagged scroll that ends away from the bottom → unpinned.
 * 2. Reaching the bottom (however) → pinned, missed count cleared.
 * 3. session-switch → pinned with atBottom false (the reset must make the
 *    owner's scrollToBottom fire — CDX-024).
 * 4. `new-entries` never changes `pinned` and never requests a scroll while
 *    unpinned (missedEntries is the ONLY thing it may touch when unpinned).
 * 5. Flagged (programmatic) scrolls never unpin.
 */

export interface PinState {
  /** The single gate: the owner effect scrolls to bottom iff this is true. */
  pinned: boolean;
  /** Geometry: is the viewport currently at (or within threshold of) the bottom. */
  atBottom: boolean;
  /** Nesting depth of flagged programmatic scrolls currently in flight. */
  programmaticDepth: number;
  /** Entries that arrived while unpinned — the jump-to-bottom pill badge. */
  missedEntries: number;
}

export type PinEvent =
  | { type: 'user-scroll'; atBottom: boolean }
  | { type: 'programmatic-scroll-start' }
  | { type: 'programmatic-scroll-end' }
  | { type: 'reached-bottom' }
  | { type: 'left-bottom' }
  | { type: 'new-entries'; count: number }
  | { type: 'session-switch' };

export const initialPinState: PinState = {
  pinned: true,
  atBottom: true,
  programmaticDepth: 0,
  missedEntries: 0,
};

export function pinReducer(state: PinState, event: PinEvent): PinState {
  switch (event.type) {
    case 'user-scroll': {
      if (state.programmaticDepth > 0) {
        // Flagged window: this scroll is the pin owner's own scrollToBottom
        // (or its momentum) — it must never unpin. Track geometry only.
        return event.atBottom
          ? { ...state, atBottom: true, missedEntries: state.pinned ? 0 : state.missedEntries }
          : { ...state, atBottom: false };
      }
      if (event.atBottom) {
        // The user landed on the bottom — re-pin (invariant 2).
        return { ...state, atBottom: true, pinned: true, missedEntries: 0 };
      }
      // Unflagged scroll away from the bottom — unpin (invariant 1).
      return { ...state, atBottom: false, pinned: false };
    }

    case 'programmatic-scroll-start':
      return { ...state, programmaticDepth: state.programmaticDepth + 1 };

    case 'programmatic-scroll-end':
      return { ...state, programmaticDepth: Math.max(0, state.programmaticDepth - 1) };

    case 'reached-bottom':
      // However the viewport got here (user fling settling, programmatic
      // scroll completing, content shrinking) — at the bottom means pinned.
      return { ...state, atBottom: true, pinned: true, missedEntries: 0 };

    case 'left-bottom':
      // Geometry only: content growth pushes the viewport off the bottom
      // without any user intent. Never unpins by itself — only an unflagged
      // user-scroll does that (invariant 1 vs 5).
      return { ...state, atBottom: false };

    case 'new-entries':
      if (state.pinned) return state; // the owner effect handles the scroll
      return { ...state, missedEntries: state.missedEntries + Math.max(0, event.count) };

    case 'session-switch':
      // Pinned but NOT atBottom: the owner effect scrolls iff pinned &&
      // !atBottom, so asserting atBottom here left a long session mid-history
      // with no jump pill (CDX-024) — the initial scroll must actually fire.
      return { ...initialPinState, atBottom: false };

    default: {
      const exhaustive: never = event;
      void exhaustive;
      return state;
    }
  }
}
