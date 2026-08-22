/**
 * Phase 8 attentionDirection (pure core of useAttentionDirection): does any
 * session before/after the current one in carousel order need attention.
 */
import { describe, expect, it } from 'vitest';
import { attentionDirection } from '../useAttentionDirection';
import type { SessionKey } from '../getOrderedSessionKeys';

const keys: SessionKey[] = [
  { machine: 'm1', sessionId: 'a' },
  { machine: 'm1', sessionId: 'b' },
  { machine: 'm2', sessionId: 'c' },
  { machine: 'm2', sessionId: 'd' },
];

const needs =
  (...ids: string[]) =>
  (key: SessionKey): boolean =>
    ids.includes(key.sessionId);

describe('attentionDirection', () => {
  it('left when an earlier session needs attention', () => {
    expect(attentionDirection(keys, 2, needs('a'))).toEqual({ left: true, right: false });
  });

  it('right when a later session needs attention', () => {
    expect(attentionDirection(keys, 1, needs('d'))).toEqual({ left: false, right: true });
  });

  it('both directions light up independently', () => {
    expect(attentionDirection(keys, 1, needs('a', 'c'))).toEqual({ left: true, right: true });
  });

  it('none when nothing needs attention (and the current one never counts)', () => {
    expect(attentionDirection(keys, 1, needs('b'))).toEqual({ left: false, right: false });
  });

  it('none for unknown current (-1) or single-item lists', () => {
    expect(attentionDirection(keys, -1, needs('a'))).toEqual({ left: false, right: false });
    expect(attentionDirection([keys[0]!], 0, () => true)).toEqual({ left: false, right: false });
  });
});
