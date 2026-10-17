//! The last 256 KiB of a terminal's output, addressed by absolute byte
//! offset.
//!
//! A phone that reconnects, or sees a gap a relay dropped, asks for a replay
//! from the last byte offset it drew; the ring is what the bridge answers it
//! with. Bytes older than the ring are gone on purpose — a phone that asks
//! for one is told where the ring really starts and resets its screen — so
//! the offset a terminal's output is numbered by is **not** the ring's own
//! position: it is the count of everything the terminal has ever written, and
//! it only ever grows. `oldest()` is where the ring's first byte sits in that
//! count, so a caller can always tell "you asked too far back" from "you are
//! up to date".

/// How much of a terminal's output is kept for a phone that comes back.
pub const CAPACITY: usize = 256 * 1024;

/// A bounded byte log: the newest [`CAPACITY`] bytes, each addressed by its
/// offset in the whole stream.
#[derive(Debug)]
pub struct Ring {
    /// The bytes held, oldest first, once the ring has wrapped; before it
    /// fills this is simply the stream so far (`start` stays 0).
    buf: Vec<u8>,
    /// Where the oldest byte sits in `buf`; 0 until the ring has wrapped.
    start: usize,
    /// Every byte ever pushed — and so the offset of the next one.
    total: u64,
}

impl Ring {
    pub fn new() -> Self {
        Self { buf: Vec::new(), start: 0, total: 0 }
    }

    /// The offset of the next byte a terminal writes: one past everything it
    /// has written.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn total(&self) -> u64 {
        self.total
    }

    /// The offset of the oldest byte still held. A replay asked for an offset
    /// before this starts here instead.
    pub fn oldest(&self) -> u64 {
        self.total - self.buf.len() as u64
    }

    /// How many bytes are held.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Append `data` and return the offset of its first byte. Past
    /// [`CAPACITY`] the oldest bytes are overwritten, so the ring always
    /// holds the newest output — which is what a phone catching up wants.
    pub fn push(&mut self, data: &[u8]) -> u64 {
        let offset = self.total;
        self.total += data.len() as u64;
        for &b in data {
            if self.buf.len() < CAPACITY {
                self.buf.push(b);
            } else {
                self.buf[self.start] = b;
                self.start = (self.start + 1) % CAPACITY;
            }
        }
        offset
    }

    /// Everything from `from` on, and the offset it actually starts at —
    /// which is `from` itself when it is still held, and [`oldest`](Self::oldest)
    /// when it is not. The returned offset is what the phone must number the
    /// bytes it is sent by, so a phone that asked too far back learns where
    /// the ring really begins.
    pub fn read_from(&self, from: u64) -> (u64, Vec<u8>) {
        let held = self.buf.len();
        let oldest = self.oldest();
        let start = from.max(oldest);
        if held == 0 || start >= self.total {
            return (self.total, Vec::new());
        }
        let skip = (start - oldest) as usize;
        let mut out = Vec::with_capacity(held - skip);
        for i in 0..held - skip {
            out.push(self.buf[(self.start + skip + i) % held]);
        }
        (start, out)
    }
}

impl Default for Ring {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_are_the_stream_count_not_the_position_in_the_ring() {
        let mut ring = Ring::new();
        assert_eq!(ring.push(b"abc"), 0);
        assert_eq!(ring.push(b"def"), 3);
        assert_eq!(ring.total(), 6);
        assert_eq!(ring.oldest(), 0);
        assert_eq!(ring.read_from(0), (0, b"abcdef".to_vec()));
        assert_eq!(ring.read_from(3), (3, b"def".to_vec()));
        assert_eq!(ring.read_from(6), (6, Vec::new()));
    }

    #[test]
    fn wraparound_keeps_the_newest_capacity_bytes_with_correct_offsets() {
        let mut ring = Ring::new();
        // One byte over capacity, so exactly one byte must have been dropped.
        let chunk = vec![b'x'; 4096];
        let mut pushed = 0u64;
        while pushed < CAPACITY as u64 + 1 {
            ring.push(&chunk);
            pushed += chunk.len() as u64;
        }
        assert_eq!(ring.total(), pushed);
        assert_eq!(ring.len(), CAPACITY);
        assert_eq!(ring.oldest(), pushed - CAPACITY as u64);

        // The oldest byte is gone; asking for it starts at the ring's start.
        let (start, all) = ring.read_from(0);
        assert_eq!(start, pushed - CAPACITY as u64);
        assert_eq!(all.len(), CAPACITY);

        // A byte still held is served from exactly where it was written.
        let (start, tail) = ring.read_from(ring.oldest() + 1);
        assert_eq!(start, ring.oldest() + 1);
        assert_eq!(tail.len(), CAPACITY - 1);

        // Bytes written after a wraparound read back in the order they went in.
        let mut ring = Ring::new();
        ring.push(&vec![b'a'; CAPACITY]);
        ring.push(b"hello");
        assert_eq!(ring.total(), CAPACITY as u64 + 5);
        assert_eq!(ring.read_from(CAPACITY as u64), (CAPACITY as u64, b"hello".to_vec()));
        assert_eq!(ring.read_from(0).1.len(), CAPACITY);
        assert_eq!(ring.read_from(0).1[CAPACITY - 5..], b"hello"[..]);
    }

    #[test]
    fn a_push_larger_than_capacity_keeps_only_its_tail() {
        let mut ring = Ring::new();
        let big = vec![b'z'; CAPACITY + 100];
        ring.push(&big);
        assert_eq!(ring.total(), CAPACITY as u64 + 100);
        assert_eq!(ring.len(), CAPACITY);
        assert_eq!(ring.oldest(), 100);
        let (start, all) = ring.read_from(0);
        assert_eq!(start, 100);
        assert_eq!(all, vec![b'z'; CAPACITY]);
    }
}
