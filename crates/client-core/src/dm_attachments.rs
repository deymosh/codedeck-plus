//! DM image attachments (CDX-011) — the pure wire-format half, ported from
//! `apps/mobile/src/core/dmAttachments.ts`.
//!
//! Wire format (unchanged from the legacy app, so old↔new clients interop): an
//! attachment is ONE LINE appended to the plain NIP-17 message content —
//!
//! ```text
//! <blossom-url> key=<aes-key-hex 64> iv=<gcm-iv-hex 24>
//! ```
//!
//! The blob on the Blossom server is the AES-256-GCM ciphertext; the key + iv
//! travel only inside the NIP-44/NIP-59 encrypted DM. The AES-GCM crypto, the
//! BUD-02 signed upload and the download path live in `client-runtime` (they
//! need `aes-gcm` + an `HttpFetch` port + a deadline/abort seam); this module
//! is the parse/build side the renderer and the composer both use.

/// Blossom server used when the user has not set one.
pub const DEFAULT_BLOSSOM_SERVER: &str = "https://blossom.descendant.io";

/// BUD-02 authorization event kind.
pub const BLOSSOM_AUTH_KIND: u16 = 24242;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedImageRef {
    pub url: String,
    /// AES-256 key, 64 hex chars (lower-case).
    pub key: String,
    /// AES-GCM IV, 24 hex chars (lower-case).
    pub iv: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DmSegment {
    Text(String),
    /// A CodeDeck encrypted attachment line.
    Image(EncryptedImageRef),
    /// A bare image URL on its own line (foreign clients send these).
    ImageUrl(String),
}

/// Build the attachment line for the send path.
pub fn build_image_ref(r: &EncryptedImageRef) -> String {
    format!("{} key={} iv={}", r.url, r.key, r.iv)
}

fn is_hex_of_len(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `https://host/path` — scheme present, at least one char after it, no
/// whitespace (the caller passes a single trimmed token).
fn looks_like_http_url(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    matches!(rest, Some(r) if !r.is_empty()) && !token.chars().any(char::is_whitespace)
}

/// One encrypted-attachment line, exactly as the legacy app emitted it:
/// `^(https?://\S+)\s+key=([0-9a-f]{64})\s+iv=([0-9a-f]{24})$` (case-insensitive).
fn parse_image_ref_line(trimmed: &str) -> Option<EncryptedImageRef> {
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() != 3 {
        return None;
    }
    if !looks_like_http_url(parts[0]) {
        return None;
    }
    let key = parts[1].strip_prefix("key=")?;
    let iv = parts[2].strip_prefix("iv=")?;
    if !is_hex_of_len(key, 64) || !is_hex_of_len(iv, 24) {
        return None;
    }
    Some(EncryptedImageRef {
        url: parts[0].to_string(),
        key: key.to_ascii_lowercase(),
        iv: iv.to_ascii_lowercase(),
    })
}

const IMAGE_EXTS: [&str; 6] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"];

/// A bare image URL on its own line:
/// `^https?://\S+\.(png|jpe?g|gif|webp|avif)(\?\S*)?$` (case-insensitive).
fn is_plain_image_line(trimmed: &str) -> bool {
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    let before_query = lower.split('?').next().unwrap_or(&lower);
    let Some(rest) = before_query
        .strip_prefix("https://")
        .or_else(|| before_query.strip_prefix("http://"))
    else {
        return false;
    };
    // `\S+\.` before the extension → at least one char precedes the ext dot.
    IMAGE_EXTS
        .iter()
        .any(|ext| rest.ends_with(ext) && rest.len() > ext.len())
}

/// Split DM content into text / inline-image segments, line-based: only lines
/// that are EXACTLY an attachment ref or a bare image URL become images —
/// anything else (a malformed key, a URL mid-sentence) stays honest text.
/// Consecutive text lines merge back into one segment.
pub fn parse_dm_content(content: &str) -> Vec<DmSegment> {
    let mut segments: Vec<DmSegment> = Vec::new();
    let mut text_run: Vec<&str> = Vec::new();

    fn flush(segments: &mut Vec<DmSegment>, text_run: &mut Vec<&str>) {
        let text = text_run.join("\n");
        if !text.trim().is_empty() {
            segments.push(DmSegment::Text(text));
        }
        text_run.clear();
    }

    for line in content.split('\n') {
        let trimmed = line.trim();
        if let Some(r) = parse_image_ref_line(trimmed) {
            flush(&mut segments, &mut text_run);
            segments.push(DmSegment::Image(r));
            continue;
        }
        if is_plain_image_line(trimmed) {
            flush(&mut segments, &mut text_run);
            segments.push(DmSegment::ImageUrl(trimmed.to_string()));
            continue;
        }
        text_run.push(line);
    }
    flush(&mut segments, &mut text_run);
    segments
}

/// Conversation-list preview: attachment / image lines read as "📷 image".
pub fn preview_text(content: &str) -> String {
    let joined = parse_dm_content(content)
        .iter()
        .map(|s| match s {
            DmSegment::Text(text) => text.as_str(),
            _ => "📷 image",
        })
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        content.to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ref_() -> EncryptedImageRef {
        EncryptedImageRef {
            url: "https://blossom.example/abc123".to_string(),
            key: "a".repeat(64),
            iv: "b".repeat(24),
        }
    }

    #[test]
    fn round_trips_build_image_ref_and_splits_text_around_it() {
        let content = format!("look at this\n{}\nnice right?", build_image_ref(&ref_()));
        assert_eq!(
            parse_dm_content(&content),
            vec![
                DmSegment::Text("look at this".to_string()),
                DmSegment::Image(ref_()),
                DmSegment::Text("nice right?".to_string()),
            ]
        );
    }

    #[test]
    fn image_only_message_and_bare_urls_from_foreign_clients() {
        assert_eq!(
            parse_dm_content(&build_image_ref(&ref_())),
            vec![DmSegment::Image(ref_())]
        );
        assert_eq!(
            parse_dm_content("https://img.example/cat.jpg?w=200"),
            vec![DmSegment::ImageUrl("https://img.example/cat.jpg?w=200".to_string())]
        );
    }

    #[test]
    fn malformed_refs_and_mid_sentence_urls_stay_honest_text() {
        let cases = [
            format!("https://x.example/y key={} iv={}", "a".repeat(10), "b".repeat(24)),
            format!("https://x.example/y key={} iv={}", "a".repeat(64), "b".repeat(10)),
            "see https://img.example/cat.png for the picture".to_string(),
            "not a url at all key=aa iv=bb".to_string(),
        ];
        for content in cases {
            assert_eq!(
                parse_dm_content(&content),
                vec![DmSegment::Text(content.clone())],
                "should stay text: {content:?}"
            );
        }
    }

    #[test]
    fn preview_text_reads_attachment_lines_as_an_image_marker() {
        assert_eq!(
            preview_text(&format!("dinner?\n{}", build_image_ref(&ref_()))),
            "dinner? 📷 image"
        );
        assert_eq!(preview_text("plain words"), "plain words");
    }

    #[test]
    fn image_ref_line_is_case_insensitive_on_the_hex_and_lower_cases_it() {
        let line = format!("https://h/x key={} iv={}", "A".repeat(64), "B".repeat(24));
        match parse_dm_content(&line).as_slice() {
            [DmSegment::Image(r)] => {
                assert_eq!(r.key, "a".repeat(64));
                assert_eq!(r.iv, "b".repeat(24));
            }
            other => panic!("expected one image segment, got {other:?}"),
        }
    }

    #[test]
    fn plain_image_line_needs_a_real_extension_and_no_bare_scheme() {
        assert_eq!(
            parse_dm_content("https://a.example/pic.WEBP"),
            vec![DmSegment::ImageUrl("https://a.example/pic.WEBP".to_string())]
        );
        // a bare scheme with just an extension is not an image URL
        assert_eq!(
            parse_dm_content("https://.png"),
            vec![DmSegment::Text("https://.png".to_string())]
        );
        // no extension → text
        assert_eq!(
            parse_dm_content("https://a.example/page"),
            vec![DmSegment::Text("https://a.example/page".to_string())]
        );
    }
}
