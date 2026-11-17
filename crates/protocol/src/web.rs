//! The browser's stream: how the bridge's web page drives sessions.
//!
//! The page is served only on the direct link's `wss://` listener, so a
//! browser reaches the bridge over TLS and never through a relay. It needs
//! no Nostr event and no NIP-44: it sends the protocol's own messages
//! ([`crate::commands::PhoneToBridge`] up, [`crate::events::BridgeToPhone`]
//! down) as JSON over one WebSocket. What TLS does not give is who sent a
//! command — the page's cookie is a bearer token — so every frame the
//! browser sends is signed by a key of its own: a WebCrypto ECDSA P-256 key
//! whose private half the page can use but never read, bound to the browser
//! when a paired phone approved its sign-in.
//!
//! Each frame is one WebSocket text message, a JSON array:
//!
//! ```text
//! bridge  → browser ["CHALLENGE", <c>]                on connect
//! browser → bridge  ["HELLO", <sig>]                  signs seq 0, empty body
//! bridge  → browser ["READY"] | ["CLOSED", <reason>]
//! browser → bridge  ["CMD", <seq>, <body>, <sig>]     body: a PhoneToBridge, as JSON text
//! bridge  → browser ["OK", <seq>, <accepted>, <message>]
//! bridge  → browser ["MSG", <message>]                a BridgeToPhone, as a JSON object
//! browser → bridge  ["PAGE", <seq>, <body>, <sig>]    a page request, as JSON text
//! bridge  → browser ["REPLY", <seq>, <reply>]         its answer, a JSON value
//! ```
//!
//! A signature is over [`signed_input`]: the machine, the browser, the
//! connection's challenge, the frame's `seq` and its body exactly as sent —
//! so neither side canonicalizes JSON, and a signature is good once, on one
//! connection to one bridge. `seq` grows on every signed frame of a
//! connection; several tabs are several connections, each with its own
//! challenge.

use base64::Engine as _;
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// What every signed input starts with, so a signature made for this stream
/// can be nothing else.
pub const SIGNING_CONTEXT: &str = "codedeck-web-v1";
/// A public key on the wire: the raw uncompressed P-256 point.
pub const PUBLIC_KEY_LEN: usize = 65;
/// A signature on the wire: WebCrypto's `r‖s`.
pub const SIGNATURE_LEN: usize = 64;
/// The largest `seq`: a JavaScript number holds integers exactly up to it.
pub const MAX_SEQ: u64 = (1 << 53) - 1;
/// How many hex characters of the key's SHA-256 are a browser's public id.
pub const BROWSER_ID_LEN: usize = 16;

/// One frame on the browser's stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebFrame {
    Challenge(String),
    Hello { sig: String },
    Ready,
    Closed(String),
    /// `body`: the JSON text of one `PhoneToBridge`, exactly as signed.
    Cmd { seq: u64, body: String, sig: String },
    Ok { seq: u64, accepted: bool, message: String },
    /// `message`: the JSON text of one `BridgeToPhone`, sent as an object.
    /// Decoding re-serializes it, so its keys come back sorted: only a
    /// browser reads these, and it reads them as JSON, not as text.
    Msg(String),
    /// `body`: the JSON text of a page request, exactly as signed.
    Page { seq: u64, body: String, sig: String },
    /// `reply`: the JSON text of the answer, sent as a value.
    Reply { seq: u64, reply: String },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("bad web frame: {0}")]
pub struct WebDecodeError(pub String);

/// Why the bridge closed a stream: the `reason` of `["CLOSED", reason]`.
pub mod closed {
    /// The `HELLO` or a later frame did not verify, or its `seq` did not grow.
    pub const BAD_SIGNATURE: &str = "bad-signature";
    /// The browser's sign-in lapsed (30 days, or 7 idle).
    pub const EXPIRED: &str = "expired";
    /// It was signed out, or revoked by a phone or another browser.
    pub const SIGNED_OUT: &str = "signed-out";
    /// It fell behind on what the bridge sends, or too many streams are open.
    pub const BUSY: &str = "busy";
    /// A frame that is not one the browser may send.
    pub const BAD_FRAME: &str = "bad-frame";
}

pub fn encode_web_frame(frame: &WebFrame) -> String {
    match frame {
        WebFrame::Challenge(c) => json!(["CHALLENGE", c]).to_string(),
        WebFrame::Hello { sig } => json!(["HELLO", sig]).to_string(),
        WebFrame::Ready => json!(["READY"]).to_string(),
        WebFrame::Closed(reason) => json!(["CLOSED", reason]).to_string(),
        WebFrame::Cmd { seq, body, sig } => json!(["CMD", seq, body, sig]).to_string(),
        WebFrame::Ok { seq, accepted, message } => json!(["OK", seq, accepted, message]).to_string(),
        // The message is already JSON: it goes in as it is, not re-parsed.
        WebFrame::Msg(message) => format!("[\"MSG\",{message}]"),
        WebFrame::Page { seq, body, sig } => json!(["PAGE", seq, body, sig]).to_string(),
        WebFrame::Reply { seq, reply } => format!("[\"REPLY\",{seq},{reply}]"),
    }
}

/// Decode one frame. Total: anything malformed is an error, never a panic.
pub fn decode_web_frame(text: &str) -> Result<WebFrame, WebDecodeError> {
    let bad = |why: &str| WebDecodeError(why.to_string());
    let value: Value = serde_json::from_str(text).map_err(|e| bad(&e.to_string()))?;
    let items = value.as_array().ok_or_else(|| bad("not an array"))?;
    let label = items.first().and_then(Value::as_str).ok_or_else(|| bad("no label"))?;
    let string = |i: usize, what: &str| items.get(i).and_then(Value::as_str).map(str::to_string).ok_or_else(|| bad(what));
    let seq = || items.get(1).and_then(Value::as_u64).filter(|s| *s <= MAX_SEQ).ok_or_else(|| bad("bad seq"));
    let arity = |n: usize| if items.len() == n { Ok(()) } else { Err(bad("wrong length")) };
    match label {
        "CHALLENGE" => {
            arity(2)?;
            Ok(WebFrame::Challenge(string(1, "bad challenge")?))
        }
        "HELLO" => {
            arity(2)?;
            Ok(WebFrame::Hello { sig: string(1, "bad signature")? })
        }
        "READY" => {
            arity(1)?;
            Ok(WebFrame::Ready)
        }
        "CLOSED" => {
            arity(2)?;
            Ok(WebFrame::Closed(string(1, "bad reason")?))
        }
        "CMD" => {
            arity(4)?;
            Ok(WebFrame::Cmd { seq: seq()?, body: string(2, "bad body")?, sig: string(3, "bad signature")? })
        }
        "OK" => {
            arity(4)?;
            Ok(WebFrame::Ok {
                seq: seq()?,
                accepted: items.get(2).and_then(Value::as_bool).ok_or_else(|| bad("bad accepted"))?,
                message: string(3, "bad message")?,
            })
        }
        "MSG" => {
            arity(2)?;
            let message = items.get(1).filter(|m| m.is_object()).ok_or_else(|| bad("bad message"))?;
            Ok(WebFrame::Msg(message.to_string()))
        }
        "PAGE" => {
            arity(4)?;
            Ok(WebFrame::Page { seq: seq()?, body: string(2, "bad body")?, sig: string(3, "bad signature")? })
        }
        "REPLY" => {
            arity(3)?;
            let reply = items.get(2).ok_or_else(|| bad("no reply"))?;
            Ok(WebFrame::Reply { seq: seq()?, reply: reply.to_string() })
        }
        _ => Err(bad("unknown label")),
    }
}

/// A browser's public key, checked: base64url of the raw uncompressed point,
/// and a point on the curve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserKey {
    raw: Vec<u8>,
    key: VerifyingKey,
}

impl BrowserKey {
    /// Read a key as the page sends it; `None` for anything that is not an
    /// uncompressed P-256 point on the curve.
    pub fn parse(base64url: &str) -> Option<Self> {
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(base64url.trim_end_matches('=')).ok()?;
        if raw.len() != PUBLIC_KEY_LEN || raw[0] != 0x04 {
            return None;
        }
        let key = VerifyingKey::from_sec1_bytes(&raw).ok()?;
        Some(Self { raw, key })
    }

    /// The key as the page sent it: base64url, no padding.
    pub fn to_base64url(&self) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&self.raw)
    }

    /// The browser's public id: the first [`BROWSER_ID_LEN`] hex characters
    /// of the SHA-256 of the raw key. What `web-browsers` lists and
    /// `web-browser-sign-out` names; it proves nothing by itself.
    pub fn id(&self) -> String {
        let mut id = hex::encode(Sha256::digest(&self.raw));
        id.truncate(BROWSER_ID_LEN);
        id
    }

    /// Whether `sig` (base64url `r‖s`) is this key's signature over `input`.
    pub fn verifies(&self, input: &[u8], sig: &str) -> bool {
        let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(sig.trim_end_matches('=')) else { return false };
        if bytes.len() != SIGNATURE_LEN {
            return false;
        }
        let Ok(signature) = Signature::from_slice(&bytes) else { return false };
        self.key.verify(input, &signature).is_ok()
    }
}

/// What a frame's signature is over: the UTF-8 of
/// `codedeck-web-v1\n<machine>\n<browser>\n<challenge>\n<seq>\n<body>`, with
/// `seq` in decimal. `HELLO` is seq 0 with an empty body.
pub fn signed_input(machine_npub: &str, browser_id: &str, challenge: &str, seq: u64, body: &str) -> Vec<u8> {
    format!("{SIGNING_CONTEXT}\n{machine_npub}\n{browser_id}\n{challenge}\n{seq}\n{body}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Made by WebCrypto (Node's, the same API the page uses):
    /// `generateKey({name: "ECDSA", namedCurve: "P-256"})`, then `sign` with
    /// SHA-256 over [`VECTOR_INPUT`]. Proves the bridge reads what a browser
    /// writes: the raw point, and `r‖s` rather than DER.
    const VECTOR_KEY: &str = "BFl8gfTaV0Lvl6YQA7eW4XLPT_Fjrid-TAPYwqFzPeNymcU9tbDYtN0tnATTjXLtL4aKeMaf4RhN6Kx2js17LaE";
    const VECTOR_SIG: &str = "w_qyb5iAhcG-HSkLYHw3VlPFGm-W3hwPwMyJ0kKbvItoSB6Ml-lqPy5PkVOWj4QCZnYi8IbgUTBwim6pcXFklQ";
    const VECTOR_BODY: &str = r#"{"v":12,"type":"refresh-sessions"}"#;

    fn vector_input() -> Vec<u8> {
        signed_input("npub1machine", "0123456789abcdef", "challenge", 1, VECTOR_BODY)
    }

    #[test]
    fn a_webcrypto_signature_verifies() {
        let key = BrowserKey::parse(VECTOR_KEY).expect("a WebCrypto raw key");
        assert!(key.verifies(&vector_input(), VECTOR_SIG));
    }

    #[test]
    fn a_signature_is_good_only_for_what_it_signed() {
        let key = BrowserKey::parse(VECTOR_KEY).unwrap();
        for (machine, browser, challenge, seq, body) in [
            ("npub1other", "0123456789abcdef", "challenge", 1, VECTOR_BODY),
            ("npub1machine", "fedcba9876543210", "challenge", 1, VECTOR_BODY),
            ("npub1machine", "0123456789abcdef", "another", 1, VECTOR_BODY),
            ("npub1machine", "0123456789abcdef", "challenge", 2, VECTOR_BODY),
            ("npub1machine", "0123456789abcdef", "challenge", 1, r#"{"v":12,"type":"refresh-sessions" }"#),
        ] {
            assert!(!key.verifies(&signed_input(machine, browser, challenge, seq, body), VECTOR_SIG), "{machine} {browser} {challenge} {seq} {body}");
        }
    }

    #[test]
    fn another_key_or_a_mangled_signature_does_not_verify() {
        let mut other = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(VECTOR_KEY).unwrap();
        // The generator point: on the curve, but not the signer.
        other[1..33].copy_from_slice(&hex::decode("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296").unwrap());
        other[33..].copy_from_slice(&hex::decode("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5").unwrap());
        let other = BrowserKey::parse(&base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(other)).expect("on the curve");
        assert!(!other.verifies(&vector_input(), VECTOR_SIG));

        let key = BrowserKey::parse(VECTOR_KEY).unwrap();
        assert!(!key.verifies(&vector_input(), "not base64!"));
        assert!(!key.verifies(&vector_input(), &VECTOR_SIG[..40]), "short");
        let mut flipped = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(VECTOR_SIG).unwrap();
        flipped[10] ^= 1;
        assert!(!key.verifies(&vector_input(), &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(flipped)));
    }

    #[test]
    fn only_an_uncompressed_point_on_the_curve_is_a_key() {
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(VECTOR_KEY).unwrap();
        let enc = |b: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
        assert!(BrowserKey::parse(&enc(&raw[..64])).is_none(), "short");
        let mut compressed = vec![0x02 | (raw[64] & 1)];
        compressed.extend_from_slice(&raw[1..33]);
        assert!(BrowserKey::parse(&enc(&compressed)).is_none(), "compressed");
        let mut off_curve = raw.clone();
        off_curve[64] ^= 1;
        assert!(BrowserKey::parse(&enc(&off_curve)).is_none(), "not on the curve");
        assert!(BrowserKey::parse("%%%").is_none());
        assert_eq!(BrowserKey::parse(VECTOR_KEY).unwrap().to_base64url(), VECTOR_KEY);
    }

    #[test]
    fn the_id_is_the_keys_hash_prefix() {
        let key = BrowserKey::parse(VECTOR_KEY).unwrap();
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(VECTOR_KEY).unwrap();
        assert_eq!(key.id(), hex::encode(Sha256::digest(&raw))[..BROWSER_ID_LEN]);
    }

    #[test]
    fn frames_round_trip() {
        for frame in [
            WebFrame::Challenge("c1".into()),
            WebFrame::Hello { sig: "s".into() },
            WebFrame::Ready,
            WebFrame::Closed(closed::EXPIRED.into()),
            WebFrame::Cmd { seq: 1, body: VECTOR_BODY.into(), sig: "s".into() },
            WebFrame::Ok { seq: 1, accepted: false, message: "not from a browser".into() },
            WebFrame::Msg(r#"{"inputId":"i","sessionId":"s","type":"input-ack","v":12}"#.into()),
            WebFrame::Page { seq: 2, body: r#"{"type":"devices"}"#.into(), sig: "s".into() },
            WebFrame::Reply { seq: 2, reply: r#"{"devices":[]}"#.into() },
        ] {
            assert_eq!(decode_web_frame(&encode_web_frame(&frame)), Ok(frame));
        }
    }

    #[test]
    fn malformed_frames_are_errors() {
        for text in [
            "",
            "{}",
            "[]",
            r#"["NOPE"]"#,
            r#"["HELLO"]"#,
            r#"["CMD", -1, "{}", "s"]"#,
            r#"["CMD", 9007199254740992, "{}", "s"]"#,
            r#"["CMD", 1, {}, "s"]"#,
            r#"["MSG", "text"]"#,
            r#"["READY", 1]"#,
        ] {
            assert!(decode_web_frame(text).is_err(), "{text}");
        }
    }
}
