/**
 * Seq-range math shared by the sync server (bridge) and transcript store
 * (phone). Ranges are inclusive [from, to] pairs over non-negative seqs.
 */
import type { SeqRange } from './schemas/commands';

/** Sort + merge overlapping/adjacent ranges into a canonical minimal form. */
export function normalizeRanges(ranges: SeqRange[]): SeqRange[] {
  const sorted = ranges
    .filter(([a, b]) => b >= a)
    .slice()
    .sort((x, y) => x[0] - y[0]);
  const out: SeqRange[] = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last && from <= last[1] + 1) {
      last[1] = Math.max(last[1], to);
    } else {
      out.push([from, to]);
    }
  }
  return out;
}

/** The ranges within [lo, hi] NOT covered by `have` — i.e. what a sync must deliver. */
export function missingRanges(have: SeqRange[], lo: number, hi: number): SeqRange[] {
  if (hi < lo) return [];
  const covered = normalizeRanges(have);
  const out: SeqRange[] = [];
  let cursor = lo;
  for (const [from, to] of covered) {
    if (to < cursor) continue;
    if (from > hi) break;
    if (from > cursor) out.push([cursor, Math.min(from - 1, hi)]);
    cursor = Math.max(cursor, to + 1);
    if (cursor > hi) break;
  }
  if (cursor <= hi) out.push([cursor, hi]);
  return out;
}

/** Split ranges into chunks of at most `size` seqs each (relay payload cap). */
export function chunkRanges(ranges: SeqRange[], size: number): SeqRange[] {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: SeqRange[] = [];
  for (const [from, to] of normalizeRanges(ranges)) {
    for (let start = from; start <= to; start += size) {
      out.push([start, Math.min(start + size - 1, to)]);
    }
  }
  return out;
}

/** Union of two range sets (e.g. accumulate delivered ranges across acks). */
export function unionRanges(a: SeqRange[], b: SeqRange[]): SeqRange[] {
  return normalizeRanges([...a, ...b]);
}

/** Subtract `b` from `a` (e.g. promised minus delivered = still owed). */
export function subtractRanges(a: SeqRange[], b: SeqRange[]): SeqRange[] {
  const out: SeqRange[] = [];
  for (const [from, to] of normalizeRanges(a)) {
    out.push(...missingRanges(b, from, to));
  }
  return normalizeRanges(out);
}

/** Total number of seqs covered. */
export function rangeSize(ranges: SeqRange[]): number {
  return normalizeRanges(ranges).reduce((n, [a, b]) => n + (b - a + 1), 0);
}

/** True when `have` fully covers [lo, hi]. */
export function covers(have: SeqRange[], lo: number, hi: number): boolean {
  return missingRanges(have, lo, hi).length === 0;
}
