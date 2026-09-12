//! Seq-range math shared by the sync server (bridge) and the transcript store
//! (client). Port of `packages/protocol/src/ranges.ts`. Ranges are inclusive
//! `(from, to)` pairs over non-negative seqs; `to < from` is treated as empty.

use std::num::NonZeroU64;

/// Inclusive `[from, to]`. Serializes to a two-element JSON array (`z.tuple`).
pub type SeqRange = (u64, u64);

/// Sort + merge overlapping/adjacent ranges into canonical minimal form.
pub fn normalize_ranges(ranges: &[SeqRange]) -> Vec<SeqRange> {
    let mut sorted: Vec<SeqRange> = ranges.iter().copied().filter(|&(a, b)| b >= a).collect();
    sorted.sort_by_key(|&(from, _)| from);

    let mut out: Vec<SeqRange> = Vec::new();
    for (from, to) in sorted {
        if let Some(last) = out.last_mut() {
            if from <= last.1.saturating_add(1) {
                last.1 = last.1.max(to);
                continue;
            }
        }
        out.push((from, to));
    }
    out
}

/// The ranges within `[lo, hi]` NOT covered by `have` — what a sync must deliver.
pub fn missing_ranges(have: &[SeqRange], lo: u64, hi: u64) -> Vec<SeqRange> {
    if hi < lo {
        return Vec::new();
    }
    let covered = normalize_ranges(have);
    let mut out = Vec::new();
    let mut cursor = lo;
    for (from, to) in covered {
        if to < cursor {
            continue;
        }
        if from > hi {
            break;
        }
        if from > cursor {
            // from > cursor >= lo >= 0  =>  from >= 1, so `from - 1` can't underflow
            out.push((cursor, (from - 1).min(hi)));
        }
        cursor = cursor.max(to.saturating_add(1));
        if cursor > hi {
            break;
        }
    }
    if cursor <= hi {
        out.push((cursor, hi));
    }
    out
}

/// Split ranges into chunks of at most `size` seqs each (relay payload cap).
/// `size` is a `NonZeroU64` — the TS `chunkRanges` throws on `size < 1`; here
/// that case is simply unrepresentable.
pub fn chunk_ranges(ranges: &[SeqRange], size: NonZeroU64) -> Vec<SeqRange> {
    let size = size.get();
    let mut out = Vec::new();
    for (from, to) in normalize_ranges(ranges) {
        let mut start = from;
        loop {
            let end = start.saturating_add(size - 1).min(to);
            out.push((start, end));
            if end >= to {
                break;
            }
            start = end + 1;
        }
    }
    out
}

/// Union of two range sets (accumulate delivered ranges across acks).
pub fn union_ranges(a: &[SeqRange], b: &[SeqRange]) -> Vec<SeqRange> {
    let mut all = a.to_vec();
    all.extend_from_slice(b);
    normalize_ranges(&all)
}

/// Subtract `b` from `a` (promised minus delivered = still owed).
pub fn subtract_ranges(a: &[SeqRange], b: &[SeqRange]) -> Vec<SeqRange> {
    let mut out = Vec::new();
    for (from, to) in normalize_ranges(a) {
        out.extend(missing_ranges(b, from, to));
    }
    normalize_ranges(&out)
}

/// Total number of seqs covered.
pub fn range_size(ranges: &[SeqRange]) -> u64 {
    normalize_ranges(ranges).iter().map(|&(a, b)| b - a + 1).sum()
}

/// True when `have` fully covers `[lo, hi]`.
pub fn covers(have: &[SeqRange], lo: u64, hi: u64) -> bool {
    missing_ranges(have, lo, hi).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nz(n: u64) -> NonZeroU64 {
        NonZeroU64::new(n).unwrap()
    }

    #[test]
    fn normalize_merges_overlapping_and_adjacent() {
        assert_eq!(normalize_ranges(&[(5, 9), (1, 3), (4, 6)]), vec![(1, 9)]);
    }

    #[test]
    fn normalize_keeps_disjoint_apart_and_drops_inverted() {
        assert_eq!(normalize_ranges(&[(10, 5), (1, 2), (4, 6)]), vec![(1, 2), (4, 6)]);
    }

    #[test]
    fn normalize_empty() {
        assert_eq!(normalize_ranges(&[]), Vec::<SeqRange>::new());
    }

    #[test]
    fn missing_full_span_when_nothing_held() {
        assert_eq!(missing_ranges(&[], 1, 100), vec![(1, 100)]);
    }

    #[test]
    fn missing_nothing_when_fully_covered() {
        assert_eq!(missing_ranges(&[(0, 200)], 1, 100), Vec::<SeqRange>::new());
    }

    #[test]
    fn missing_finds_gaps_mid_stream_ephemeral_loss() {
        assert_eq!(
            missing_ranges(&[(1, 40), (61, 80)], 1, 100),
            vec![(41, 60), (81, 100)]
        );
    }

    #[test]
    fn missing_handles_hi_lt_lo_empty_transcript() {
        assert_eq!(missing_ranges(&[], 1, 0), Vec::<SeqRange>::new());
    }

    #[test]
    fn chunk_splits_into_fixed_size() {
        assert_eq!(chunk_ranges(&[(1, 10)], nz(4)), vec![(1, 4), (5, 8), (9, 10)]);
    }

    #[test]
    fn chunk_never_merges_across_disjoint() {
        assert_eq!(chunk_ranges(&[(1, 2), (10, 11)], nz(100)), vec![(1, 2), (10, 11)]);
    }

    #[test]
    fn union_accumulates_across_acks() {
        assert_eq!(
            union_ranges(&[(1, 5)], &[(6, 9), (20, 22)]),
            vec![(1, 9), (20, 22)]
        );
    }

    #[test]
    fn subtract_computes_still_owed() {
        assert_eq!(subtract_ranges(&[(1, 100)], &[(1, 40), (61, 100)]), vec![(41, 60)]);
    }

    #[test]
    fn covers_is_the_completeness_check_after_sync_end() {
        assert!(covers(&[(1, 917)], 1, 917));
        assert!(!covers(&[(1, 916)], 1, 917));
    }

    #[test]
    fn range_size_counts_inclusive_seqs() {
        assert_eq!(range_size(&[(1, 1), (3, 5)]), 4);
    }

    #[test]
    fn property_missing_plus_have_partitions_the_span() {
        let have: Vec<SeqRange> = vec![(3, 7), (12, 15), (15, 30), (40, 41)];
        let (lo, hi) = (0u64, 50u64);
        let missing = missing_ranges(&have, lo, hi);
        let together = union_ranges(&missing, &have);
        assert!(covers(&together, lo, hi));

        let have_clamped: Vec<SeqRange> = normalize_ranges(&have)
            .into_iter()
            .map(|(a, b)| (a.max(lo), b.min(hi)))
            .collect();
        assert_eq!(range_size(&missing) + range_size(&have_clamped), hi - lo + 1);
    }
}
