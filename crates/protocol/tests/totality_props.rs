//! Totality: every public decoder returns `Ok` or `Err` for whatever reaches
//! it — arbitrary bytes, and arbitrary mutations of the messages the corpus
//! says are valid. A panic here is a remote crash: these inputs come from a
//! relay or a peer, not from code we control. The properties call the
//! decoders and do nothing else; proptest reports a panic as a failure and
//! shrinks the input to a minimal one.
//!
//! Cases per property: see [`CASES`]. Enough to walk the decoders' UTF-8,
//! index and serde paths on every run, small enough to stay well inside a
//! debug test run.

use proptest::prelude::*;
use protocol::chunking::{frame_encoded_message, parse_chunk_envelope, ChunkAssembler};
use protocol::direct::decode_direct_frame;
use protocol::{decode_bridge_to_phone, decode_phone_to_bridge};
use serde_json::Value;

/// Anything at or below the point where a decoder would have to be quadratic
/// to notice; the corpus mutations below cover the large-payload paths.
const CASES: u32 = 256;

const CORPUS: &str = include_str!("../fixtures/corpus.json");

fn config() -> ProptestConfig {
    // The source-tree regression file is for `src` unit tests; these live in
    // `tests/`, where proptest cannot find it and says so every run. A
    // failure still prints its seed, so it is reproducible from the output.
    ProptestConfig { cases: CASES, failure_persistence: None, ..ProptestConfig::default() }
}

/// Every public decoder the phone and the bridge ingest with, on one input.
/// `now_ms` is pushed to both ends of the assembler's clock too, so a single
/// `offer` also exercises the TTL sweep.
fn exercise_ingest(text: &str) {
    let _ = decode_phone_to_bridge(text);
    let _ = decode_bridge_to_phone(text);
    let _ = decode_direct_frame(text);
    let _ = parse_chunk_envelope(text);
    let mut assembler = ChunkAssembler::new();
    let _ = assembler.offer(text, 0);
    let _ = assembler.offer(text, u64::MAX);
}

/// Every wire message the corpus calls valid, in its wire form (a packed
/// fixture is used verbatim), plus real chunk fragments — one message per
/// fragment — so the mutation property reaches the assembler with frames it
/// would otherwise only see from a real bridge.
fn valid_wire_messages() -> &'static [String] {
    static MESSAGES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    MESSAGES.get_or_init(|| {
        let corpus: Value = serde_json::from_str(CORPUS).expect("corpus.json is valid JSON");
        let mut out = Vec::new();
        for dir in ["phoneToBridge", "bridgeToPhone"] {
            for msg in corpus[dir]["valid"].as_array().expect("a valid list") {
                out.push(msg.as_str().map(str::to_string).unwrap_or_else(|| msg.to_string()));
            }
        }
        for frame in corpus["directFrames"]["valid"].as_array().expect("a valid list") {
            out.push(frame.to_string());
        }
        let large = format!(r#"{{"type":"output","sessionId":"s","seq":1,"content":"{}"}}"#, "x".repeat(200_000));
        out.extend(frame_encoded_message(&large, || "cid-property".to_string()));
        out
    })
}

/// Flip, overwrite or delete bytes, then pass the result through as UTF-8
/// (a decoder takes `&str`; invalid sequences become U+FFFD, as a lossy read
/// of a hostile payload would).
fn mutate(text: &str, mutations: &[u8]) -> String {
    let mut bytes = text.as_bytes().to_vec();
    for (k, m) in mutations.iter().enumerate() {
        if bytes.is_empty() {
            break;
        }
        let at = (usize::from(*m) * 31 + k) % bytes.len();
        match *m % 3 {
            0 => bytes[at] ^= 0x5a,
            1 => bytes[at] = *m,
            _ => {
                bytes.remove(at);
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

proptest! {
    #![proptest_config(config())]

    /// Unstructured text: no message shape at all, which is what a hostile
    /// relay or a scan of random traffic delivers.
    #[test]
    fn arbitrary_text_never_panics_an_ingest_decoder(text in any::<String>()) {
        exercise_ingest(&text);
    }

    #[test]
    fn arbitrary_bytes_never_panic_an_ingest_decoder(bytes in proptest::collection::vec(any::<u8>(), 0..256)) {
        exercise_ingest(&String::from_utf8_lossy(&bytes));
    }

    /// Near-valid traffic: one to a handful of corrupted bytes in a message
    /// the corpus accepts. This is the shape a decoder bug hides in — a body
    /// that parses until a field is missing, an index is short or a length
    /// runs past the end.
    #[test]
    fn mutated_valid_messages_never_panic_an_ingest_decoder(
        index in 0usize..valid_wire_messages().len(),
        mutations in proptest::collection::vec(any::<u8>(), 0..=24),
    ) {
        let text = mutate(&valid_wire_messages()[index], &mutations);
        exercise_ingest(&text);
    }
}
