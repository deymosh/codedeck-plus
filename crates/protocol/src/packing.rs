//! Compressing a message before it is encrypted. Wire JSON repeats itself —
//! keys, timestamps, an agent catalog, a transcript's paths and code — and
//! deflate shrinks it several times over, so a message takes fewer
//! fragments and a relay gets less of it. A packed payload is
//! [`PACKED_PREFIX`] followed by the base64 of the raw deflate stream; a
//! plain message is a JSON object, so it always starts with `{` and the two
//! never clash. A message is packed only when that makes it smaller, and
//! unpacking is capped, so a hostile payload cannot inflate without bound.

use std::borrow::Cow;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

/// What a packed payload starts with.
pub const PACKED_PREFIX: char = '~';
/// Shorter messages are sent as they are: a small one does not shrink by
/// enough to pay for the base64.
pub const PACK_MIN_BYTES: usize = 1024;
/// The most a packed payload may inflate to — far past any message.
pub const MAX_UNPACKED_BYTES: usize = 32 * 1024 * 1024;
/// Deflate's level: well into the diminishing returns, and still well under
/// a millisecond for a message.
const LEVEL: u8 = 6;

/// `encoded` (a message's wire JSON), packed when that makes it smaller.
pub fn pack(encoded: String) -> String {
    if encoded.len() < PACK_MIN_BYTES {
        return encoded;
    }
    let deflated = miniz_oxide::deflate::compress_to_vec(encoded.as_bytes(), LEVEL);
    let packed = format!("{PACKED_PREFIX}{}", STANDARD.encode(deflated));
    if packed.len() < encoded.len() {
        packed
    } else {
        encoded
    }
}

/// The wire JSON of `payload`, packed or not.
pub fn unpack(payload: &str) -> Result<Cow<'_, str>, String> {
    let Some(b64) = payload.strip_prefix(PACKED_PREFIX) else {
        return Ok(Cow::Borrowed(payload));
    };
    let deflated = STANDARD.decode(b64).map_err(|e| format!("invalid packed payload: {e}"))?;
    let inflated = miniz_oxide::inflate::decompress_to_vec_with_limit(&deflated, MAX_UNPACKED_BYTES)
        .map_err(|e| format!("invalid packed payload: {:?}", e.status))?;
    String::from_utf8(inflated)
        .map(Cow::Owned)
        .map_err(|_| "invalid packed payload: not UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wordy() -> String {
        let entry = r#"{"timestamp":"2026-09-30T12:00:00.000Z","entryType":"tool_call","callId":"c","toolName":"Read","kind":"read","title":"crates/protocol/src/packing.rs"}"#;
        format!(r#"{{"type":"output","sessionId":"s","seq":1,"entries":[{}]}}"#, vec![entry; 40].join(","))
    }

    #[test]
    fn a_long_message_packs_small_and_unpacks_to_itself() {
        let json = wordy();
        let packed = pack(json.clone());
        assert!(packed.starts_with(PACKED_PREFIX));
        assert!(packed.len() * 4 < json.len(), "{} -> {}", json.len(), packed.len());
        assert_eq!(unpack(&packed).unwrap(), json);
    }

    #[test]
    fn a_short_message_or_one_that_would_not_shrink_goes_as_it_is() {
        let short = r#"{"type":"input-ack","sessionId":"s","inputId":"i"}"#.to_string();
        assert_eq!(pack(short.clone()), short);
        // Random bytes, as base64, do not shrink by what base64 costs.
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        let bytes: Vec<u8> = (0..3000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect();
        let noise = STANDARD.encode(bytes);
        let json = format!(r#"{{"text":"{noise}"}}"#);
        assert_eq!(pack(json.clone()), json);
        assert!(matches!(unpack(&json).unwrap(), Cow::Borrowed(_)));
    }

    #[test]
    fn a_bad_packed_payload_is_an_error_not_a_panic() {
        assert!(unpack("~not base64!").is_err());
        assert!(unpack(&format!("~{}", STANDARD.encode(b"not deflate at all"))).is_err());
        let bytes = miniz_oxide::deflate::compress_to_vec(&[0xff, 0xfe, 0xfd], 6);
        assert!(unpack(&format!("~{}", STANDARD.encode(bytes))).is_err());
    }

    #[test]
    fn unpacking_is_capped() {
        let bomb = miniz_oxide::deflate::compress_to_vec(&vec![b'a'; MAX_UNPACKED_BYTES + 1], 6);
        assert!(unpack(&format!("~{}", STANDARD.encode(bomb))).is_err());
    }
}
