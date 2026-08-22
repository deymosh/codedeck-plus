/**
 * useSwipeToNavigate (Phase 8) — horizontal swipe carousel between the items
 * of an ordered list, ported from the old app's hooks/useSwipeToNavigate.ts
 * and made generic: `{ items, currentIndex, onNavigate(index), wrap }`.
 *
 * Sessions clamp at the edges (wrap: false); DM/Marmot conversations cycle
 * (wrap: true — the old cycleIndex). Only active on touch devices
 * (`(pointer: coarse)`).
 *
 * Two elements are involved, deliberately decoupled (old-app design):
 *  - `touchHandlers` go on the outer touch target (the whole panel) so a
 *    swipe can start anywhere, including over the input bar.
 *  - `sliderRef` goes on the inner element that actually translates — the
 *    hook slides a container AROUND the transcript; it NEVER scrolls the
 *    transcript itself (useTranscriptPin stays the single scroll owner).
 *
 * Ref-based DOM manipulation like useSwipeToDelete: transform/transition are
 * written imperatively, so the slider element must not set them in CSS.
 */
import { useCallback, useRef } from 'react';
import { useMediaQuery } from './useMediaQuery';

export const SWIPE_THRESHOLD_PX = 60;
export const SWIPE_DAMPEN = 0.4;
export const SWIPE_DEBOUNCE_MS = 400;
export const SLIDE_DURATION_MS = 200;

/** Wrap-around index step (old utils/cycleIndex — DM conversations cycle). */
export const cycleIndex = (current: number, length: number, dir: 1 | -1): number =>
  (current + dir + length) % length;

/**
 * Index a swipe in `dir` lands on, or null when navigation is impossible
 * (single/empty list, unknown current, or a clamped edge).
 */
export function swipeTargetIndex(
  current: number,
  length: number,
  dir: 1 | -1,
  wrap: boolean,
): number | null {
  if (length <= 1 || current < 0 || current >= length) return null;
  if (wrap) return cycleIndex(current, length, dir);
  const next = current + dir;
  return next < 0 || next >= length ? null : next;
}

export function useSwipeToNavigate<T>({
  items,
  currentIndex,
  onNavigate,
  wrap,
  enabled = true,
}: {
  /** The ordered list being navigated (length is what matters). */
  items: readonly T[];
  /** Index of the item currently shown; -1 disables the gesture. */
  currentIndex: number;
  /** Called (mid-slide, at the content switch) with the target index. */
  onNavigate: (index: number) => void;
  /** true → cycle at the edges (DMs); false → clamp (sessions). */
  wrap: boolean;
  /** Extra caller gate on top of the built-in coarse-pointer gate. */
  enabled?: boolean;
}): {
  sliderRef: React.RefObject<HTMLDivElement | null>;
  touchHandlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
  };
} {
  const isCoarse = useMediaQuery('(pointer: coarse)');
  const active = enabled && isCoarse;

  // Swipe left (dx < 0) shows the NEXT item; swipe right the PREVIOUS.
  const nextIndex = swipeTargetIndex(currentIndex, items.length, 1, wrap);
  const prevIndex = swipeTargetIndex(currentIndex, items.length, -1, wrap);
  const canSwipeLeft = nextIndex !== null;
  const canSwipeRight = prevIndex !== null;

  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const currentXRef = useRef(0);
  const swipingRef = useRef(false);
  const directionLockedRef = useRef(false);
  const lastSwipeTimeRef = useRef(0);
  const sliderRef = useRef<HTMLDivElement>(null);

  const snapBack = useCallback(() => {
    const el = sliderRef.current;
    if (!el) return;
    el.style.transition = `transform ${SLIDE_DURATION_MS}ms ease-out`;
    el.style.transform = 'translateX(0)';
  }, []);

  /**
   * Carousel-style transition: slide current content out, switch item (the
   * onNavigate → store selection → re-render), then slide the new content in
   * from the opposite side.
   */
  const slideOut = useCallback(
    (exitOffset: string, targetIndex: number, enterOffset: string) => {
      const el = sliderRef.current;
      if (!el) return;
      // Phase 1: slide out (accelerate away)
      el.style.transition = `transform ${SLIDE_DURATION_MS}ms ease-in`;
      el.style.transform = `translateX(${exitOffset})`;
      setTimeout(() => {
        // Phase 2: switch item, position at enter side (no transition).
        //
        // CDX-086: re-read the ref after onNavigate. SessionScreen is now keyed
        // per session (MainPanel), so navigating REMOUNTS it and the node
        // captured above is detached — styling it would silently lose the
        // slide-in half of the animation.
        onNavigate(targetIndex);
        const entering = sliderRef.current;
        if (!entering) return;
        entering.style.transition = 'none';
        entering.style.transform = `translateX(${enterOffset})`;
        // Phase 3: slide in to center (double rAF ensures the browser paints
        // the off-screen position first)
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const settling = sliderRef.current;
            if (!settling) return;
            settling.style.transition = `transform ${SLIDE_DURATION_MS}ms ease-out`;
            settling.style.transform = 'translateX(0)';
          });
        });
      }, SLIDE_DURATION_MS);
    },
    [onNavigate],
  );

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!active) return;
      const t = e.touches[0];
      if (!t) return;
      startXRef.current = t.clientX;
      startYRef.current = t.clientY;
      currentXRef.current = 0;
      swipingRef.current = false;
      directionLockedRef.current = false;
      const el = sliderRef.current;
      if (el) el.style.transition = 'none';
    },
    [active],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!active) return;
      // Direction already locked as vertical — let scroll happen
      if (directionLockedRef.current && !swipingRef.current) return;

      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startXRef.current;
      const dy = t.clientY - startYRef.current;

      // Not enough movement to determine direction yet
      if (!directionLockedRef.current && Math.abs(dx) < 10 && Math.abs(dy) < 10) return;

      // Lock direction on first significant movement
      if (!directionLockedRef.current) {
        directionLockedRef.current = true;
        if (Math.abs(dy) > Math.abs(dx)) {
          // Vertical scroll — abort horizontal swipe
          return;
        }
        swipingRef.current = true;
      }

      // Suppress drag visual at clamped edges
      if (dx < 0 && !canSwipeLeft) return;
      if (dx > 0 && !canSwipeRight) return;

      currentXRef.current = dx;
      const el = sliderRef.current;
      if (el) el.style.transform = `translateX(${dx * SWIPE_DAMPEN}px)`;
    },
    [active, canSwipeLeft, canSwipeRight],
  );

  const onTouchEnd = useCallback(() => {
    if (!swipingRef.current) return;

    const now = Date.now();
    const dx = currentXRef.current;

    // Debounce rapid swipes
    if (now - lastSwipeTimeRef.current < SWIPE_DEBOUNCE_MS) {
      snapBack();
      swipingRef.current = false;
      return;
    }

    if (dx < -SWIPE_THRESHOLD_PX) {
      if (nextIndex === null) {
        snapBack();
      } else {
        lastSwipeTimeRef.current = now;
        slideOut(`-${window.innerWidth}px`, nextIndex, `${window.innerWidth}px`);
      }
    } else if (dx > SWIPE_THRESHOLD_PX) {
      if (prevIndex === null) {
        snapBack();
      } else {
        lastSwipeTimeRef.current = now;
        slideOut(`${window.innerWidth}px`, prevIndex, `-${window.innerWidth}px`);
      }
    } else {
      snapBack();
    }

    swipingRef.current = false;
    currentXRef.current = 0;
  }, [nextIndex, prevIndex, slideOut, snapBack]);

  return {
    sliderRef,
    touchHandlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}
