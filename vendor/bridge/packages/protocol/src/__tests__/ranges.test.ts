import { describe, expect, it } from 'vitest';
import {
  chunkRanges,
  covers,
  missingRanges,
  normalizeRanges,
  rangeSize,
  subtractRanges,
  unionRanges,
} from '../ranges';
import type { SeqRange } from '../schemas/commands';

describe('normalizeRanges', () => {
  it('merges overlapping and adjacent ranges', () => {
    expect(normalizeRanges([[5, 9], [1, 3], [4, 6]])).toEqual([[1, 9]]);
  });
  it('keeps disjoint ranges apart and drops inverted ones', () => {
    expect(normalizeRanges([[10, 5], [1, 2], [4, 6]])).toEqual([[1, 2], [4, 6]]);
  });
  it('handles empty input', () => {
    expect(normalizeRanges([])).toEqual([]);
  });
});

describe('missingRanges', () => {
  it('returns the full span when nothing is held', () => {
    expect(missingRanges([], 1, 100)).toEqual([[1, 100]]);
  });
  it('returns nothing when fully covered', () => {
    expect(missingRanges([[0, 200]], 1, 100)).toEqual([]);
  });
  it('finds gaps between held ranges — the mid-stream ephemeral-loss case', () => {
    expect(missingRanges([[1, 40], [61, 80]], 1, 100)).toEqual([[41, 60], [81, 100]]);
  });
  it('handles hi < lo (empty transcript)', () => {
    expect(missingRanges([], 1, 0)).toEqual([]);
  });
});

describe('chunkRanges', () => {
  it('splits a large range into fixed-size chunks', () => {
    expect(chunkRanges([[1, 10]], 4)).toEqual([[1, 4], [5, 8], [9, 10]]);
  });
  it('never merges across disjoint ranges', () => {
    expect(chunkRanges([[1, 2], [10, 11]], 100)).toEqual([[1, 2], [10, 11]]);
  });
  it('rejects nonsense chunk sizes', () => {
    expect(() => chunkRanges([[1, 5]], 0)).toThrow();
  });
});

describe('union / subtract / covers / size', () => {
  it('union accumulates delivered ranges across acks', () => {
    expect(unionRanges([[1, 5]], [[6, 9], [20, 22]])).toEqual([[1, 9], [20, 22]]);
  });
  it('subtract computes still-owed = promised minus delivered', () => {
    expect(subtractRanges([[1, 100]], [[1, 40], [61, 100]])).toEqual([[41, 60]]);
  });
  it('covers is the phone-side completeness check after sync-end', () => {
    expect(covers([[1, 917]], 1, 917)).toBe(true);
    expect(covers([[1, 916]], 1, 917)).toBe(false);
  });
  it('rangeSize counts inclusive seqs', () => {
    expect(rangeSize([[1, 1], [3, 5]])).toBe(4);
  });
  it('property: missing + have partitions the span', () => {
    const have: SeqRange[] = [[3, 7], [12, 15], [15, 30], [40, 41]];
    const lo = 0;
    const hi = 50;
    const missing = missingRanges(have, lo, hi);
    const together = unionRanges(missing, have);
    expect(covers(together, lo, hi)).toBe(true);
    expect(rangeSize(missing) + rangeSize(normalizeRanges(have).map((r) => [Math.max(r[0], lo), Math.min(r[1], hi)] as SeqRange))).toBe(hi - lo + 1);
  });
});
