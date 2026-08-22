/**
 * useTranscriptPin — the ONE owner of transcript auto-scroll (bug C's cure).
 *
 * This hook is the ONLY place in the app that calls scrollToBottom, and it
 * does so in exactly one effect, gated on `pinned` from the pure pinReducer.
 * Every programmatic scroll is flagged (programmatic-scroll-start/end around
 * the scrollToIndex call) so the reducer can tell the pin owner's scrolls from
 * the user's — any UNFLAGGED scroll away from the bottom unpins, reaching the
 * bottom re-pins, and new entries NEVER move the viewport while unpinned.
 *
 * The old app's four competing drivers (new-entry timers, ResizeObserver,
 * react-window onResize, session-switch timers) are all gone: session switch
 * and new entries are reducer events feeding the same single effect, and
 * virtua's own content-shift compensation replaces the ResizeObserver hack.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { VListHandle } from 'virtua';
import { initialPinState, pinReducer, type PinEvent } from './pinReducer';

/** Distance (px) from the true bottom still counted as "at bottom". */
export const BOTTOM_THRESHOLD_PX = 24;

/** Fallback for programmatic scrolls that produce no onScrollEnd (already at
 *  the target): the flag window must always close. */
const PROGRAMMATIC_FLAG_TIMEOUT_MS = 400;

export interface TranscriptPin {
  /** Reducer truth: is the view following the stream. */
  pinned: boolean;
  /** Entries that arrived while unpinned — the jump-pill badge count. */
  missedEntries: number;
  /** Wire to VList's onScroll. */
  onScroll: () => void;
  /** Wire to VList's onScrollEnd. */
  onScrollEnd: () => void;
  /** Explicit user action (jump-to-bottom pill): re-pin + scroll. */
  jumpToBottom: () => void;
}

export function useTranscriptPin({
  listRef,
  itemCount,
  sessionKey,
}: {
  listRef: React.RefObject<VListHandle | null>;
  /** Total rendered rows — growth means new entries. */
  itemCount: number;
  /** Identity of the shown session — change resets the pin. */
  sessionKey: string;
}): TranscriptPin {
  /**
   * A fresh MOUNT must behave exactly like a session switch, for the same
   * CDX-024 reason: the owner effect scrolls iff `pinned && !atBottom`, so
   * starting at `atBottom: true` means the initial scroll never fires and a long
   * transcript opens mid-history with no jump pill.
   *
   * This used to be reachable only via the `session-switch` event, because
   * SessionScreen stayed mounted across a session change. CDX-086 keys it per
   * session (a composer's draft and staged attachment must not follow the user
   * into another session), so a switch is now a REMOUNT and this path is the one
   * that runs. Both entries agree deliberately — see the `session-switch` case.
   */
  const [state, dispatch] = useReducer(pinReducer, undefined, () => ({
    ...initialPinState,
    atBottom: false,
  }));
  const stateRef = useRef(state);
  stateRef.current = state;

  const flagTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flagOpen = useRef(false);

  const send = useCallback((event: PinEvent) => dispatch(event), []);

  const atBottomNow = useCallback((): boolean => {
    const handle = listRef.current;
    if (!handle) return true;
    return handle.scrollOffset + handle.viewportSize >= handle.scrollSize - BOTTOM_THRESHOLD_PX;
  }, [listRef]);

  /** Close the programmatic flag window (idempotent — reducer clamps). */
  const closeFlag = useCallback(() => {
    if (!flagOpen.current) return;
    flagOpen.current = false;
    if (flagTimer.current) {
      clearTimeout(flagTimer.current);
      flagTimer.current = null;
    }
    send({ type: 'programmatic-scroll-end' });
  }, [send]);

  /**
   * THE scrollToBottom — the single point that moves the viewport. Flags the
   * window first so the resulting scroll events cannot be mistaken for the
   * user's; the window closes on onScrollEnd or the timeout fallback.
   */
  const scrollToBottom = useCallback(() => {
    const handle = listRef.current;
    if (!handle || itemCount === 0) return;
    if (!flagOpen.current) {
      flagOpen.current = true;
      send({ type: 'programmatic-scroll-start' });
    }
    if (flagTimer.current) clearTimeout(flagTimer.current);
    flagTimer.current = setTimeout(closeFlag, PROGRAMMATIC_FLAG_TIMEOUT_MS);
    handle.scrollToIndex(itemCount - 1, { align: 'end' });
  }, [listRef, itemCount, send, closeFlag]);
  const scrollToBottomRef = useRef(scrollToBottom);
  scrollToBottomRef.current = scrollToBottom;

  // Session switch: reset the reducer, then the pinned effect below lands the
  // fresh session at the bottom (no timers, no second driver).
  const prevSessionKey = useRef(sessionKey);
  if (prevSessionKey.current !== sessionKey) {
    prevSessionKey.current = sessionKey;
    flagOpen.current = false;
    if (flagTimer.current) {
      clearTimeout(flagTimer.current);
      flagTimer.current = null;
    }
    dispatch({ type: 'session-switch' });
  }

  // New entries: geometry may have left the bottom; tell the reducer. This is
  // an EVENT, not a scroll — the one effect below decides whether to move.
  const prevCount = useRef(itemCount);
  useEffect(() => {
    const delta = itemCount - prevCount.current;
    prevCount.current = itemCount;
    if (delta > 0) {
      if (!atBottomNow()) send({ type: 'left-bottom' });
      send({ type: 'new-entries', count: delta });
    }
  }, [itemCount, atBottomNow, send]);

  // ★ THE single pin-owner effect — the only scroll driver in the app. ★
  useEffect(() => {
    if (state.pinned && itemCount > 0 && !state.atBottom) {
      scrollToBottomRef.current();
    }
  }, [state.pinned, state.atBottom, itemCount]);

  const onScroll = useCallback(() => {
    const atBottom = atBottomNow();
    // The reducer attributes this to the program while the flag window is open.
    send({ type: 'user-scroll', atBottom });
    // A flagged jump that landed on the bottom has done its job — close the
    // window NOW so the user's very next drag counts as theirs (keeping the
    // window open across streaming appends would re-create the yank bug).
    if (flagOpen.current && atBottom) closeFlag();
  }, [atBottomNow, send, closeFlag]);

  const onScrollEnd = useCallback(() => {
    closeFlag();
    if (atBottomNow()) send({ type: 'reached-bottom' });
  }, [closeFlag, atBottomNow, send]);

  const jumpToBottom = useCallback(() => {
    send({ type: 'reached-bottom' }); // explicit intent: pin now
    scrollToBottomRef.current();
  }, [send]);

  // Unmount: never leave a dangling timer.
  useEffect(
    () => () => {
      if (flagTimer.current) clearTimeout(flagTimer.current);
    },
    [],
  );

  return {
    pinned: state.pinned,
    missedEntries: state.missedEntries,
    onScroll,
    onScrollEnd,
    jumpToBottom,
  };
}
