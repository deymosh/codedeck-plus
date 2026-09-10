//! Pure helpers for the session image-upload path (Phase 5, CDX-029): base64
//! chunking for the legacy relay fallback transport plus small conversions.
//! Port of `apps/mobile/src/core/imageChunks.ts`.
//!
//! 35 KB per chunk leaves room for the JSON envelope + NIP-44 encryption
//! overhead within the ~48 KB relay event limit. No sockets, no timers — the
//! inter-chunk publish delay is the runtime's.

use base64::Engine as _;

pub const IMAGE_CHUNK_BYTES: usize = 35_000;

/// Inter-chunk publish delay (relay rate-limit courtesy; legacy value). The
/// runtime applies it — this module is pure.
pub const IMAGE_CHUNK_DELAY_MS: u64 = 200;

/// Split a base64 string into relay-safe pieces, in order, lossless. Base64 is
/// ASCII, so slicing on byte boundaries never splits a character.
pub fn chunk_base64(base64: &str, max_chunk_bytes: usize) -> Vec<String> {
    debug_assert!(max_chunk_bytes > 0);
    if base64.len() <= max_chunk_bytes {
        return vec![base64.to_string()];
    }
    base64
        .as_bytes()
        .chunks(max_chunk_bytes)
        .map(|c| String::from_utf8(c.to_vec()).expect("base64 is ASCII"))
        .collect()
}

/// Decode base64 (no `data:` prefix) to raw bytes — the Blossom upload input.
pub fn base64_to_bytes(base64: &str) -> Result<Vec<u8>, base64::DecodeError> {
    base64::engine::general_purpose::STANDARD.decode(base64)
}

/// Blossom blob id from a ref URL — the upload builds it as
/// `<server>/<sha256_hex>`, so the id is the last path segment (the
/// `upload-image` blossom message carries it as `hash`).
pub fn blossom_hash_from_url(url: &str) -> &str {
    match url.rfind('/') {
        Some(i) => &url[i + 1..],
        None => url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_base64_identity_and_boundary() {
        assert_eq!(chunk_base64("abc", IMAGE_CHUNK_BYTES), vec!["abc"]);
        let at_limit = "a".repeat(IMAGE_CHUNK_BYTES);
        assert_eq!(chunk_base64(&at_limit, IMAGE_CHUNK_BYTES).len(), 1);
    }

    #[test]
    fn chunk_base64_splits_into_ordered_lossless_pieces() {
        let b64 = format!("{}{}", "x".repeat(90_000), "TAIL");
        let chunks = chunk_base64(&b64, IMAGE_CHUNK_BYTES);
        assert_eq!(chunks.len(), b64.len().div_ceil(IMAGE_CHUNK_BYTES)); // 3
        assert_eq!(chunks[0].len(), IMAGE_CHUNK_BYTES);
        assert_eq!(chunks[1].len(), IMAGE_CHUNK_BYTES);
        assert_eq!(chunks.concat(), b64);
    }

    #[test]
    fn chunk_base64_honours_a_custom_size() {
        assert_eq!(chunk_base64("abcdefgh", 3), vec!["abc", "def", "gh"]);
    }

    #[test]
    fn base64_to_bytes_round_trips_and_handles_empty() {
        let bytes = [0u8, 1, 2, 250, 255, 128];
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert_eq!(base64_to_bytes(&b64).unwrap(), bytes);
        assert!(base64_to_bytes("").unwrap().is_empty());
    }

    #[test]
    fn blossom_hash_from_url_extracts_the_trailing_segment() {
        let hash = "f".repeat(64);
        assert_eq!(
            blossom_hash_from_url(&format!("https://blossom.descendant.io/{hash}")),
            hash
        );
        assert_eq!(blossom_hash_from_url("bare"), "bare");
    }
}
