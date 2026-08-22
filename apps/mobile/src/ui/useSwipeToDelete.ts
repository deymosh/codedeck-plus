/**
 * useSwipeToDelete — swipe-left-to-delete, ported ~verbatim from the old
 * app's hook: 10px dead zone before direction lock, vertical-dominant moves
 * never swipe, left-only translateX, ≥80px commits with a 0.2s ease-out
 * slide-out before onDelete fires; anything less snaps back.
 *
 * No extra DOM layers — the element itself is translated via inline style;
 * the caller renders the red backdrop underneath (Sidebar's swipeTrack).
 */
import { useCallback, useRef, type TouchEvent } from 'react';

const SWIPE_THRESHOLD = 80;

export function useSwipeToDelete<T extends HTMLElement = HTMLDivElement>(onDelete: () => void) {
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const currentXRef = useRef(0);
  const swipingRef = useRef(false);
  const elRef = useRef<T>(null);

  const onTouchStart = useCallback((e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    startXRef.current = t.clientX;
    startYRef.current = t.clientY;
    currentXRef.current = 0;
    swipingRef.current = false;
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - startXRef.current;
    const dy = t.clientY - startYRef.current;

    // Determine direction on first significant move
    if (!swipingRef.current && Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    if (!swipingRef.current) {
      // Vertical scroll is dominant — don't swipe
      if (Math.abs(dy) > Math.abs(dx)) return;
      swipingRef.current = true;
    }

    const offset = Math.min(0, dx); // Only left
    currentXRef.current = offset;
    const el = elRef.current;
    if (el) {
      el.style.transition = 'none';
      el.style.transform = `translateX(${offset}px)`;
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!swipingRef.current) return;
    const el = elRef.current;
    if (!el) return;

    if (Math.abs(currentXRef.current) >= SWIPE_THRESHOLD) {
      // Full swipe — animate off-screen then delete
      el.style.transition = 'transform 0.2s ease-out';
      el.style.transform = 'translateX(-100%)';
      setTimeout(onDelete, 200);
    } else {
      // Snap back
      el.style.transition = 'transform 0.2s ease-out';
      el.style.transform = 'translateX(0)';
    }
    swipingRef.current = false;
    currentXRef.current = 0;
  }, [onDelete]);

  return {
    ref: elRef,
    touchHandlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}
