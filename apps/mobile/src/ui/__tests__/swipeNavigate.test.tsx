// @vitest-environment jsdom
/**
 * Phase 8 useSwipeToNavigate: the ported carousel hook — 60px threshold,
 * 400ms debounce, 200ms slide, clamp (sessions) vs wrap (DMs), vertical
 * direction lock, and the (pointer: coarse) gate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  SLIDE_DURATION_MS,
  SWIPE_DEBOUNCE_MS,
  cycleIndex,
  swipeTargetIndex,
  useSwipeToNavigate,
} from '../useSwipeToNavigate';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mockMatchMedia(matches: boolean): void {
  (window as unknown as Record<string, unknown>)['matchMedia'] = (query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

function Harness({
  currentIndex,
  wrap,
  onNavigate,
  length = 3,
}: {
  currentIndex: number;
  wrap: boolean;
  onNavigate: (index: number) => void;
  length?: number;
}) {
  const items = Array.from({ length }, (_, i) => `item-${i}`);
  const { sliderRef, touchHandlers } = useSwipeToNavigate({
    items,
    currentIndex,
    onNavigate,
    wrap,
  });
  return (
    <div data-testid="swipe-target" {...touchHandlers}>
      <div data-testid="slider" ref={sliderRef} />
    </div>
  );
}

const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

/** Horizontal swipe from (200, 50) by dx, then release. */
function swipe(el: Element, dx: number, dy = 0): void {
  fireEvent.touchStart(el, touch(200, 50));
  fireEvent.touchMove(el, touch(200 + dx, 50 + dy));
  fireEvent.touchEnd(el);
}

function renderHarness(props: Parameters<typeof Harness>[0]) {
  render(<Harness {...props} />);
  return screen.getByTestId('swipe-target');
}

describe('swipeTargetIndex (pure)', () => {
  it('clamps at the edges when wrap is false', () => {
    expect(swipeTargetIndex(2, 3, 1, false)).toBeNull();
    expect(swipeTargetIndex(0, 3, -1, false)).toBeNull();
    expect(swipeTargetIndex(1, 3, 1, false)).toBe(2);
    expect(swipeTargetIndex(1, 3, -1, false)).toBe(0);
  });

  it('cycles at the edges when wrap is true (old cycleIndex)', () => {
    expect(swipeTargetIndex(2, 3, 1, true)).toBe(0);
    expect(swipeTargetIndex(0, 3, -1, true)).toBe(2);
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
  });

  it('disables on empty/single lists and unknown current', () => {
    expect(swipeTargetIndex(0, 1, 1, true)).toBeNull();
    expect(swipeTargetIndex(-1, 3, 1, false)).toBeNull();
    expect(swipeTargetIndex(0, 0, 1, true)).toBeNull();
  });
});

describe('useSwipeToNavigate', () => {
  it('a ≥60px left swipe navigates to the next index after the 200ms slide', () => {
    mockMatchMedia(true);
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const target = renderHarness({ currentIndex: 1, wrap: false, onNavigate });

    swipe(target, -80);
    expect(onNavigate).not.toHaveBeenCalled(); // navigation waits for slide-out
    act(() => vi.advanceTimersByTime(SLIDE_DURATION_MS + 50));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('a ≥60px right swipe navigates to the previous index', () => {
    mockMatchMedia(true);
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const target = renderHarness({ currentIndex: 1, wrap: false, onNavigate });

    swipe(target, 80);
    act(() => vi.advanceTimersByTime(SLIDE_DURATION_MS + 50));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('sub-threshold swipe snaps back without navigating', () => {
    mockMatchMedia(true);
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const target = renderHarness({ currentIndex: 1, wrap: false, onNavigate });

    swipe(target, -50);
    act(() => vi.advanceTimersByTime(1000));
    expect(onNavigate).not.toHaveBeenCalled();
    expect((screen.getByTestId('slider') as HTMLElement).style.transform).toBe('translateX(0)');
  });

  it('drag translates the slider with 0.4 damping', () => {
    mockMatchMedia(true);
    const target = renderHarness({ currentIndex: 1, wrap: false, onNavigate: vi.fn() });

    fireEvent.touchStart(target, touch(200, 50));
    fireEvent.touchMove(target, touch(100, 50)); // dx = -100
    expect((screen.getByTestId('slider') as HTMLElement).style.transform).toBe(
      'translateX(-40px)',
    );
  });

  it('debounces: a second swipe within 400ms snaps back, after 400ms it navigates', () => {
    mockMatchMedia(true);
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const target = renderHarness({ currentIndex: 0, wrap: true, onNavigate });

    swipe(target, -80);
    act(() => vi.advanceTimersByTime(SLIDE_DURATION_MS)); // commit #1 lands
    expect(onNavigate).toHaveBeenCalledTimes(1);

    // Still inside the 400ms debounce window (200ms elapsed) → ignored.
    swipe(target, -80);
    act(() => vi.advanceTimersByTime(SLIDE_DURATION_MS));
    expect(onNavigate).toHaveBeenCalledTimes(1);

    // Past the window → accepted.
    act(() => vi.advanceTimersByTime(SWIPE_DEBOUNCE_MS));
    swipe(target, -80);
    act(() => vi.advanceTimersByTime(SLIDE_DURATION_MS));
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it('clamps at the last index (wrap: false): no navigation, no drag visual', () => {
    mockMatchMedia(true);
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const target = renderHarness({ currentIndex: 2, wrap: false, onNavigate });

    fireEvent.touchStart(target, touch(200, 50));
    fireEvent.touchMove(target, touch(100, 50)); // left swipe at the right edge
    expect((screen.getByTestId('slider') as HTMLElement).style.transform).toBe('');
    fireEvent.touchEnd(target);
    act(() => vi.advanceTimersByTime(1000));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('wraps at the last index (wrap: true): left swipe cycles to 0', () => {
    mockMatchMedia(true);
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const target = renderHarness({ currentIndex: 2, wrap: true, onNavigate });

    swipe(target, -80);
    act(() => vi.advanceTimersByTime(SLIDE_DURATION_MS + 50));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('vertical movement locks direction as scroll — no navigation', () => {
    mockMatchMedia(true);
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const target = renderHarness({ currentIndex: 1, wrap: false, onNavigate });

    fireEvent.touchStart(target, touch(200, 50));
    fireEvent.touchMove(target, touch(190, 150)); // dy dominates → vertical
    fireEvent.touchMove(target, touch(100, 150)); // later horizontal drift ignored
    fireEvent.touchEnd(target);
    act(() => vi.advanceTimersByTime(1000));
    expect(onNavigate).not.toHaveBeenCalled();
    expect((screen.getByTestId('slider') as HTMLElement).style.transform).toBe('');
  });

  it('coarse-pointer gate: fine pointers never swipe', () => {
    mockMatchMedia(false);
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const target = renderHarness({ currentIndex: 1, wrap: false, onNavigate });

    swipe(target, -120);
    act(() => vi.advanceTimersByTime(1000));
    expect(onNavigate).not.toHaveBeenCalled();
    expect((screen.getByTestId('slider') as HTMLElement).style.transform).toBe('');
  });
});
