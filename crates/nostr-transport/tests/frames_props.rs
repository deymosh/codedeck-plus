//! Totality: [`parse_relay_message`] runs in the socket read loop on
//! whatever a relay sends, so it must answer `Ok` or `Err` for any text —
//! including a frame that is one byte away from valid. A panic here kills the
//! read loop rather than dropping the frame.
//!
//! Cases per property: [`CASES`] keeps this a few seconds in debug while still
//! walking every verb's argument checks; proptest shrinks a failure to a
//! minimal input.

use nostr_transport::frames::parse_relay_message;
use proptest::prelude::*;

const CASES: u32 = 256;

/// Frames the relay side legitimately sends, one per parsed shape (plus an
/// unknown verb, which is `Unknown` rather than an error).
const VALID_FRAMES: &[&str] = &[
    r#"["EVENT","sub-1",{"id":"aa","kind":24515,"pubkey":"bb","content":"x","tags":[],"created_at":1,"sig":"cc"}]"#,
    r#"["EOSE","s"]"#,
    r#"["CLOSED","s","auth-required: nope"]"#,
    r#"["CLOSED","s"]"#,
    r#"["OK","evt-id",true,""]"#,
    r#"["OK","evt-id",false,"rate-limited: slow down"]"#,
    r#"["NOTICE","hello"]"#,
    r#"["AUTH","challenge-xyz"]"#,
    r#"["COUNT","s",{"count":3}]"#,
];

/// Flip, overwrite or delete bytes, then pass the result through as UTF-8 (the
/// parser takes `&str`; invalid sequences become U+FFFD, as a lossy read of a
/// hostile frame would).
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
    #![proptest_config(ProptestConfig {
        cases: CASES,
        // These live in `tests/`, where proptest cannot find the source-tree
        // regression file and warns every run; a failure still prints its seed.
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn arbitrary_text_never_panics_the_relay_frame_parser(text in any::<String>()) {
        let _ = parse_relay_message(&text);
    }

    #[test]
    fn arbitrary_bytes_never_panic_the_relay_frame_parser(bytes in proptest::collection::vec(any::<u8>(), 0..256)) {
        let _ = parse_relay_message(&String::from_utf8_lossy(&bytes));
    }

    #[test]
    fn mutated_relay_frames_never_panic_the_parser(frames in prop::sample::select(VALID_FRAMES), mutations in proptest::collection::vec(any::<u8>(), 0..=24)) {
        let _ = parse_relay_message(&mutate(frames, &mutations));
    }
}
