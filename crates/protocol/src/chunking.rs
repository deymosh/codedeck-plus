//! Event-content fragmentation — the transport layer BELOW the semantic
//! protocol. Port of `packages/protocol/src/chunking.ts`.
//!
//! Every bridge→phone message rides one Nostr event as `base64(NIP-44(JSON))` in
//! `event.content`. Relays cap `content` at 65535 bytes. A large model reply is
//! a single `OutputEntry` whose serialized JSON exceeds that once NIP-44-padded,
//! so the bridge fails to publish it at all. The fix (analogue of IP
//! fragmentation): split the encoded JSON **string** into N `chunk` envelopes,
//! each independently encrypted onto its own event; the receiver buffers by
//! `cid` and, once all `n` are present, concatenates them back into the exact
//! original JSON and feeds it through the normal decode path. Every semantic
//! field — `seq` included — is untouched, so ordering / dedup / retries / sync /
//! reconnection keep operating on `seq` exactly as before. A small message is
//! never wrapped.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

/// The relay's hard limit on `event.content` (bytes). HAVEN and the Fiatjaf
/// eventstore both pin `MaxContentSize = math.MaxUint16`.
pub const MAX_EVENT_CONTENT_BYTES: usize = 65535;

/// Largest NIP-44 v2 plaintext (bytes) whose encrypted `content` (base64) stays
/// within [`MAX_EVENT_CONTENT_BYTES`]. The padding boundary is a hard step at
/// 40960: plaintext ≤ 40960 → content 54704 ✅; 40961 → content 65628 ❌.
pub const NIP44_SAFE_PLAINTEXT_BYTES: usize = 40960;

/// Reserved headroom inside [`NIP44_SAFE_PLAINTEXT_BYTES`] for the `chunk`
/// wrapper's own JSON overhead. A lower bound the binary search targets.
pub const CHUNK_ENVELOPE_MARGIN: usize = 64;

/// Wire `type` of a fragment envelope. Deliberately NOT part of
/// `bridgeToPhoneSchema` — the semantic layer must never see a fragment.
pub const CHUNK_MESSAGE_TYPE: &str = "chunk";

/// Idle-group discard window (ms). The missing message is then recovered by the
/// existing gap-heal path (sync retry).
pub const CHUNK_ASSEMBLY_TTL_MS: u64 = 60_000;

const DEFAULT_MAX_OPEN: usize = 64;
const DEFAULT_MAX_BYTES: usize = 8 * 1024 * 1024;

/// A fragment envelope. Field order matches `JSON.stringify({type,cid,i,n,part})`
/// so [`parse_chunk_envelope`]'s cheap `{"type":"chunk"` prefix check works.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkEnvelope {
    #[serde(rename = "type")]
    pub kind: String,
    /// Random id (16 bytes hex) tying one message's fragments together.
    pub cid: String,
    /// 0-based fragment index, `0 <= i < n`.
    pub i: u64,
    /// Total fragment count. Always ≥ 2 — a 1-part message is never wrapped.
    pub n: u64,
    /// This fragment's slice of the original encoded-message JSON string.
    pub part: String,
}

/// UTF-8 byte length. Trivial in Rust (`str` is UTF-8) — kept under the TS name
/// for parity; the TS version exists only because JS strings are UTF-16.
#[inline]
pub fn utf8_size(s: &str) -> usize {
    s.len()
}

fn encode_envelope(cid: &str, i: u64, n: u64, part: &str) -> String {
    serde_json::to_string(&ChunkEnvelope {
        kind: CHUNK_MESSAGE_TYPE.to_string(),
        cid: cid.to_string(),
        i,
        n,
        part: part.to_string(),
    })
    .expect("ChunkEnvelope always serializes")
}

/// Fragment an already-encoded bridge→phone message JSON string for the wire.
///
/// - Fits one event (`json.len() <= NIP44_SAFE_PLAINTEXT_BYTES`): returns
///   `[json]` UNCHANGED.
/// - Too large: returns N `chunk` envelope JSON strings, each
///   `len() <= NIP44_SAFE_PLAINTEXT_BYTES`. Concatenating the `part` fields in
///   index order reproduces `json` byte-for-byte.
///
/// The split is *measured*, not arithmetic: a binary search sizes each slice by
/// the real envelope's serialized length, so JSON re-escaping of `part` can
/// never push a fragment over budget. Slices land on UTF-8 char boundaries.
///
/// Panics only in the impossible case that the budget cannot fit a single char.
pub fn frame_encoded_message(json: &str, mut make_cid: impl FnMut() -> String) -> Vec<String> {
    if json.len() <= NIP44_SAFE_PLAINTEXT_BYTES {
        return vec![json.to_string()];
    }

    let cid = make_cid();
    let budget = NIP44_SAFE_PLAINTEXT_BYTES - CHUNK_ENVELOPE_MARGIN;
    let mut parts: Vec<&str> = Vec::new();
    let mut pos = 0usize;

    while pos < json.len() {
        let remaining = json.len() - pos;
        let (mut lo, mut hi, mut best) = (1usize, remaining, 0usize);
        while lo <= hi {
            let mid = (lo + hi) / 2;
            // snap pos+mid down to a char boundary; `take` is the byte length
            let mut end = pos + mid;
            while end > pos && !json.is_char_boundary(end) {
                end -= 1;
            }
            let take = end - pos;
            if take == 0 {
                lo = mid + 1; // the char at `pos` is wider than `mid`; grow
                continue;
            }
            if encode_envelope(&cid, 0, 0, &json[pos..end]).len() <= budget {
                best = take;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        assert!(best > 0, "frame_encoded_message: chunk budget too small to make progress");
        parts.push(&json[pos..pos + best]);
        pos += best;
    }

    let n = parts.len() as u64;
    parts
        .iter()
        .enumerate()
        .map(|(i, part)| encode_envelope(&cid, i as u64, n, part))
        .collect()
}

/// If `plaintext` is a well-formed `chunk` envelope, return it; otherwise `None`
/// (the caller then handles `plaintext` as an ordinary message). A string that
/// *looks* like a chunk but fails the shape returns `None` too.
pub fn parse_chunk_envelope(plaintext: &str) -> Option<ChunkEnvelope> {
    // cheap pre-filter: frame_encoded_message always emits `type` first
    if !plaintext.starts_with(r#"{"type":"chunk""#) {
        return None;
    }
    let env: ChunkEnvelope = serde_json::from_str(plaintext).ok()?;
    if env.kind != CHUNK_MESSAGE_TYPE || env.cid.is_empty() || env.n < 2 {
        return None;
    }
    Some(env)
}

/// Result of offering a plaintext to a [`ChunkAssembler`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssemblerResult {
    /// Not a fragment — process `plaintext` as an ordinary message.
    Passthrough,
    /// A fragment was buffered; nothing to dispatch yet.
    Buffered,
    /// All fragments present — `json` is the reassembled message.
    Assembled { json: String },
    /// A fragment envelope that cannot belong to any valid message.
    Invalid { error: String },
}

#[derive(Debug)]
struct OpenBuffer {
    n: u64,
    parts: BTreeMap<u64, String>,
    bytes: usize,
    first_seen_at: u64,
}

/// Reassembles `chunk` fragments back into whole message JSON.
///
/// - Out-of-order fragments: assembled by index.
/// - Duplicate `(cid, i)`: ignored (idempotent).
/// - `i >= n`, or a second fragment for a `cid` with a different `n`: the first
///   is `Invalid`, the second abandons the old group and starts fresh.
/// - Missing fragment: the group never completes and is swept after `ttl_ms`;
///   partial content is NEVER surfaced.
/// - Bounded: at most `max_open` groups and `max_bytes` buffered; the oldest
///   group is evicted past either cap.
///
/// `now_ms` is passed in per call — the runtime supplies real time, tests a
/// fake clock (the `Clock` port lives one layer up).
#[derive(Debug)]
pub struct ChunkAssembler {
    ttl_ms: u64,
    max_open: usize,
    max_bytes: usize,
    open: HashMap<String, OpenBuffer>,
    total_bytes: usize,
}

impl Default for ChunkAssembler {
    fn default() -> Self {
        Self::with_limits(CHUNK_ASSEMBLY_TTL_MS, DEFAULT_MAX_OPEN, DEFAULT_MAX_BYTES)
    }
}

impl ChunkAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_limits(ttl_ms: u64, max_open: usize, max_bytes: usize) -> Self {
        Self {
            ttl_ms,
            max_open,
            max_bytes,
            open: HashMap::new(),
            total_bytes: 0,
        }
    }

    /// Open (incomplete) fragment groups — diagnostics / tests.
    pub fn open_count(&self) -> usize {
        self.open.len()
    }

    /// Drop groups older than `ttl_ms`. Stale ⟺ `now - first_seen >= ttl`
    /// (the TS computes `first_seen <= now - ttl` in signed arithmetic — a
    /// `saturating_sub` on the cutoff would wrongly drop everything at now=0).
    pub fn sweep(&mut self, now_ms: u64) {
        let stale: Vec<String> = self
            .open
            .iter()
            .filter(|(_, b)| now_ms.saturating_sub(b.first_seen_at) >= self.ttl_ms)
            .map(|(cid, _)| cid.clone())
            .collect();
        for cid in stale {
            self.drop(&cid);
        }
    }

    pub fn offer(&mut self, plaintext: &str, now_ms: u64) -> AssemblerResult {
        self.sweep(now_ms);

        let env = match parse_chunk_envelope(plaintext) {
            Some(e) => e,
            None => return AssemblerResult::Passthrough,
        };
        if env.i >= env.n {
            return AssemblerResult::Invalid {
                error: format!("chunk index {} out of range for n={}", env.i, env.n),
            };
        }

        if let Some(buf) = self.open.get(&env.cid) {
            if buf.n != env.n {
                // same cid, different fragment count — collision or corrupt sender
                self.drop(&env.cid);
            }
        }
        if !self.open.contains_key(&env.cid) {
            if self.open.len() >= self.max_open {
                self.evict_oldest(None);
            }
            self.open.insert(
                env.cid.clone(),
                OpenBuffer {
                    n: env.n,
                    parts: BTreeMap::new(),
                    bytes: 0,
                    first_seen_at: now_ms,
                },
            );
        }

        {
            use std::collections::btree_map::Entry;
            let buf = self.open.get_mut(&env.cid).expect("just inserted");
            if let Entry::Vacant(slot) = buf.parts.entry(env.i) {
                let size = utf8_size(&env.part);
                slot.insert(env.part.clone());
                buf.bytes += size;
                self.total_bytes += size;
            }
        }
        while self.total_bytes > self.max_bytes && self.open.len() > 1 {
            self.evict_oldest(Some(&env.cid));
        }

        let buf = self.open.get(&env.cid).expect("present");
        if (buf.parts.len() as u64) < buf.n {
            return AssemblerResult::Buffered;
        }
        // complete: BTreeMap iterates in key order
        let json: String = buf.parts.values().cloned().collect();
        self.drop(&env.cid);
        AssemblerResult::Assembled { json }
    }

    fn drop(&mut self, cid: &str) {
        if let Some(buf) = self.open.remove(cid) {
            self.total_bytes -= buf.bytes;
        }
    }

    fn evict_oldest(&mut self, except_cid: Option<&str>) {
        let oldest = self
            .open
            .iter()
            .filter(|(cid, _)| Some(cid.as_str()) != except_cid)
            .min_by_key(|(_, b)| b.first_seen_at)
            .map(|(cid, _)| cid.clone());
        if let Some(cid) = oldest {
            self.drop(&cid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic cid factory.
    fn cid_gen(prefix: &'static str) -> impl FnMut() -> String {
        let mut n = 0u32;
        move || {
            let s = format!("{prefix}{n}");
            n += 1;
            s
        }
    }

    /// A plausible large JSON-shaped string of ~`bytes` length (stands in for
    /// `encodeBridgeToPhone(outputOfSize(bytes))` — the codec lands later).
    fn big_json(bytes: usize, filler: &str) -> String {
        let head = r#"{"type":"output","sessionId":"s1","seq":12345,"entry":{"entryType":"text","content":""#;
        let tail = r#"","timestamp":"2026-08-05T00:00:00.000Z"}}"#;
        let pad = bytes.saturating_sub(head.len() + tail.len());
        let body: String = filler.chars().cycle().take(pad).collect();
        format!("{head}{body}{tail}")
    }

    #[test]
    fn small_message_is_never_wrapped() {
        let json = r#"{"type":"output","sessionId":"s1","seq":7,"entry":{"entryType":"text","content":"hello"}}"#;
        let frames = frame_encoded_message(json, cid_gen("cid"));
        assert_eq!(frames, vec![json.to_string()]);
    }

    #[test]
    fn message_right_at_the_threshold_goes_out_as_one_frame() {
        let json = big_json(NIP44_SAFE_PLAINTEXT_BYTES, "x");
        assert!(json.len() <= NIP44_SAFE_PLAINTEXT_BYTES);
        assert_eq!(frame_encoded_message(&json, cid_gen("cid")), vec![json.clone()]);
    }

    #[test]
    fn oversize_splits_into_ge2_fragments_each_within_the_cap_and_reassembles_exactly() {
        let json = big_json(200_000, "x");
        let frames = frame_encoded_message(&json, cid_gen("cid"));
        assert!(frames.len() >= 2);
        for (idx, f) in frames.iter().enumerate() {
            assert!(utf8_size(f) <= NIP44_SAFE_PLAINTEXT_BYTES);
            let env = parse_chunk_envelope(f).unwrap();
            assert_eq!(env.kind, CHUNK_MESSAGE_TYPE);
            assert_eq!(env.n as usize, frames.len());
            assert_eq!(env.i as usize, idx);
        }
        let rebuilt: String = frames.iter().map(|f| parse_chunk_envelope(f).unwrap().part).collect();
        assert_eq!(rebuilt, json);
    }

    #[test]
    fn every_fragment_shares_one_cid_distinct_messages_get_distinct_cids() {
        let mut make = cid_gen("grp");
        let a = frame_encoded_message(&big_json(120_000, "x"), &mut make);
        let b = frame_encoded_message(&big_json(120_000, "x"), &mut make);
        let cid_of = |frames: &[String]| {
            frames.iter().map(|f| parse_chunk_envelope(f).unwrap().cid).collect::<std::collections::HashSet<_>>()
        };
        let ca = cid_of(&a);
        let cb = cid_of(&b);
        assert_eq!(ca.len(), 1);
        assert_eq!(cb.len(), 1);
        assert_ne!(ca, cb);
    }

    #[test]
    fn survives_multibyte_quote_heavy_content_without_corrupting_the_split() {
        let nasty = "\u{201C}quote\u{201D} \u{1D54F} \\ \"escaped\" \n".repeat(20_000);
        let json = format!(r#"{{"type":"output","seq":1,"content":{}}}"#, serde_json::to_string(&nasty).unwrap());
        let frames = frame_encoded_message(&json, cid_gen("cid"));
        assert!(frames.len() > 1);
        for f in &frames {
            assert!(utf8_size(f) <= NIP44_SAFE_PLAINTEXT_BYTES);
        }
        let rebuilt: String = frames.iter().map(|f| parse_chunk_envelope(f).unwrap().part).collect();
        assert_eq!(rebuilt, json);
    }

    #[test]
    fn parse_chunk_envelope_rejects_ordinary_and_invalid() {
        assert!(parse_chunk_envelope(r#"{"type":"output","seq":1}"#).is_none());
        assert!(parse_chunk_envelope("not json").is_none());
        assert!(parse_chunk_envelope("[]").is_none());
        assert!(parse_chunk_envelope(r#"{"type":"chunk","cid":"c","i":0}"#).is_none()); // no n/part
        assert!(parse_chunk_envelope(r#"{"type":"chunk","cid":"c","i":0,"n":1,"part":"x"}"#).is_none()); // n<2
    }

    #[test]
    fn parse_chunk_envelope_round_trips_a_valid_envelope() {
        let raw = r#"{"type":"chunk","cid":"c1","i":2,"n":4,"part":"abc"}"#;
        let env = parse_chunk_envelope(raw).unwrap();
        assert_eq!(env, ChunkEnvelope { kind: "chunk".into(), cid: "c1".into(), i: 2, n: 4, part: "abc".into() });
        assert_eq!(serde_json::to_string(&env).unwrap(), raw);
    }

    #[test]
    fn assembler_passes_ordinary_messages_straight_through() {
        let mut a = ChunkAssembler::new();
        assert_eq!(
            a.offer(r#"{"type":"output","sessionId":"s","seq":1,"entry":{}}"#, 0),
            AssemblerResult::Passthrough
        );
    }

    #[test]
    fn assembler_reassembles_in_order_into_the_exact_original() {
        let json = big_json(150_000, "x");
        let frames = frame_encoded_message(&json, || "g1".to_string());
        let mut a = ChunkAssembler::new();
        for f in &frames[..frames.len() - 1] {
            assert_eq!(a.offer(f, 0), AssemblerResult::Buffered);
        }
        assert_eq!(
            a.offer(frames.last().unwrap(), 0),
            AssemblerResult::Assembled { json: json.clone() }
        );
        assert_eq!(a.open_count(), 0);
    }

    #[test]
    fn assembler_reassembles_out_of_order() {
        let json = big_json(150_000, "x");
        let mut frames = frame_encoded_message(&json, || "g2".to_string());
        frames.reverse();
        let mut a = ChunkAssembler::new();
        let mut last = AssemblerResult::Buffered;
        for f in &frames {
            last = a.offer(f, 0);
        }
        assert_eq!(last, AssemblerResult::Assembled { json });
    }

    #[test]
    fn assembler_ignores_a_duplicated_fragment() {
        let json = big_json(90_000, "x");
        let frames = frame_encoded_message(&json, || "g3".to_string());
        let mut a = ChunkAssembler::new();
        a.offer(&frames[0], 0);
        a.offer(&frames[0], 0);
        a.offer(&frames[0], 0);
        let mut last = AssemblerResult::Buffered;
        for f in &frames[1..] {
            last = a.offer(f, 0);
        }
        assert!(matches!(last, AssemblerResult::Assembled { .. }));
    }

    #[test]
    fn assembler_rejects_a_fragment_whose_index_is_out_of_range() {
        let mut a = ChunkAssembler::new();
        let bad = r#"{"type":"chunk","cid":"x","i":5,"n":3,"part":"p"}"#;
        match a.offer(bad, 0) {
            AssemblerResult::Invalid { error } => assert!(error.contains("out of range")),
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn assembler_never_surfaces_partial_and_sweeps_after_ttl() {
        let mut a = ChunkAssembler::with_limits(1000, DEFAULT_MAX_OPEN, DEFAULT_MAX_BYTES);
        let json = big_json(150_000, "x");
        let frames = frame_encoded_message(&json, || "gap".to_string());
        for f in &frames[..frames.len() - 1] {
            assert_eq!(a.offer(f, 0), AssemblerResult::Buffered);
        }
        assert_eq!(a.open_count(), 1);
        a.sweep(2000); // past TTL
        assert_eq!(a.open_count(), 0);
        // the straggler cannot resurrect a completed message
        assert_eq!(a.offer(frames.last().unwrap(), 2000), AssemblerResult::Buffered);
    }

    #[test]
    fn assembler_keeps_interleaved_messages_separate_by_cid() {
        let json_a = big_json(120_000, "x");
        let json_b = big_json(90_000, "y");
        let fa = frame_encoded_message(&json_a, || "A".to_string());
        let fb = frame_encoded_message(&json_b, || "B".to_string());
        let mut a = ChunkAssembler::new();
        let mut out: Vec<String> = Vec::new();
        for i in 0..fa.len().max(fb.len()) {
            if let Some(f) = fa.get(i) {
                if let AssemblerResult::Assembled { json } = a.offer(f, 0) {
                    out.push(json);
                }
            }
            if let Some(f) = fb.get(i) {
                if let AssemblerResult::Assembled { json } = a.offer(f, 0) {
                    out.push(json);
                }
            }
        }
        out.sort();
        let mut want = vec![json_a, json_b];
        want.sort();
        assert_eq!(out, want);
    }

    #[test]
    fn assembler_bounds_open_groups_oldest_evicted_past_max_open() {
        let mut a = ChunkAssembler::with_limits(CHUNK_ASSEMBLY_TTL_MS, 2, DEFAULT_MAX_BYTES);
        for (t, cid) in ["a", "b", "c"].iter().enumerate() {
            let frag = format!(r#"{{"type":"chunk","cid":"{cid}","i":0,"n":2,"part":"p"}}"#);
            a.offer(&frag, t as u64);
        }
        assert_eq!(a.open_count(), 2);
    }

    #[test]
    fn nip44_safe_plaintext_boundary_against_real_nip44() {
        use nostr::key::Keys;
        use nostr::nips::nip44::{self, Version};
        let a = Keys::generate();
        let b = Keys::generate();

        let at = nip44::encrypt(a.secret_key(), &b.public_key(), "x".repeat(NIP44_SAFE_PLAINTEXT_BYTES), Version::V2).unwrap();
        assert!(at.len() <= MAX_EVENT_CONTENT_BYTES, "safe plaintext must fit the cap, got {}", at.len());

        let over = nip44::encrypt(a.secret_key(), &b.public_key(), "x".repeat(NIP44_SAFE_PLAINTEXT_BYTES + 1), Version::V2).unwrap();
        assert!(over.len() > MAX_EVENT_CONTENT_BYTES, "one byte past crosses the padding block");
        assert_eq!(over.len(), 65628, "the exact number from the bug report");

        // sampled: every length 1..=SAFE encrypts within the cap
        for len in (1..=NIP44_SAFE_PLAINTEXT_BYTES).step_by(1023) {
            let ct = nip44::encrypt(a.secret_key(), &b.public_key(), "x".repeat(len), Version::V2).unwrap();
            assert!(ct.len() <= MAX_EVENT_CONTENT_BYTES, "len={len}");
        }
    }
}
