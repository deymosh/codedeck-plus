/**
 * useKeyboardInset logic (Phase 5a) — pure inset math + the controller over a
 * fake visualViewport (the plan §5 replacement for the old App.tsx hack).
 */
import { describe, expect, it } from 'vitest';
import {
  attachKeyboardInset,
  computeKeyboardInset,
  type ViewportLike,
} from '../useKeyboardInset';

describe('computeKeyboardInset', () => {
  it('keyboard open: layout minus visual height is the inset', () => {
    expect(computeKeyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
  });

  it('accounts for a visual-viewport top offset', () => {
    expect(computeKeyboardInset(800, { height: 500, offsetTop: 100 })).toBe(200);
  });

  it('keyboard closed: zero, including sub-2px engine noise', () => {
    expect(computeKeyboardInset(800, { height: 800, offsetTop: 0 })).toBe(0);
    expect(computeKeyboardInset(800, { height: 799, offsetTop: 0 })).toBe(0);
    expect(computeKeyboardInset(800, { height: 801, offsetTop: 0 })).toBe(0); // negative
  });
});

function fakeViewport(height: number): ViewportLike & {
  set(height: number, offsetTop?: number): void;
  fire(type: 'resize' | 'scroll'): void;
  listenerCount(): number;
} {
  const listeners = new Map<string, Set<() => void>>();
  const vp = {
    height,
    offsetTop: 0,
    addEventListener(type: 'resize' | 'scroll', handler: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: 'resize' | 'scroll', handler: () => void) {
      listeners.get(type)?.delete(handler);
    },
    set(h: number, offsetTop = 0) {
      vp.height = h;
      vp.offsetTop = offsetTop;
    },
    fire(type: 'resize' | 'scroll') {
      for (const handler of listeners.get(type) ?? []) handler();
    },
    listenerCount: () =>
      [...listeners.values()].reduce((acc, set) => acc + set.size, 0),
  };
  return vp;
}

describe('attachKeyboardInset', () => {
  it('applies 0 on attach, tracks keyboard open/close via resize events', () => {
    const vp = fakeViewport(800);
    const applied: number[] = [];
    attachKeyboardInset({
      viewport: vp,
      layoutHeight: () => 800,
      apply: (inset) => applied.push(inset),
    });
    expect(applied).toEqual([0]);

    vp.set(500); // keyboard opened
    vp.fire('resize');
    expect(applied).toEqual([0, 300]);

    vp.fire('scroll'); // no change → deduped
    expect(applied).toEqual([0, 300]);

    vp.set(800); // keyboard closed
    vp.fire('resize');
    expect(applied).toEqual([0, 300, 0]);
  });

  it('detach removes both listeners', () => {
    const vp = fakeViewport(800);
    const detach = attachKeyboardInset({
      viewport: vp,
      layoutHeight: () => 800,
      apply: () => {},
    });
    expect(vp.listenerCount()).toBe(2);
    detach();
    expect(vp.listenerCount()).toBe(0);
  });

  it('no visualViewport (old engine): applies 0 once and never crashes', () => {
    const applied: number[] = [];
    const detach = attachKeyboardInset({
      viewport: null,
      layoutHeight: () => 800,
      apply: (inset) => applied.push(inset),
    });
    expect(applied).toEqual([0]);
    detach();
  });
});
