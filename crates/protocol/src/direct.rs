//! The direct link: a bridge's own WebSocket, beside the relays.
//!
//! A paired phone that can reach the bridge directly (LAN, VPN, or an onion
//! service) exchanges the SAME signed Nostr events with it over one
//! WebSocket instead of through a relay: no relay in the path, no REQ/EOSE,
//! just a handshake and then events both ways. Pairing still happens over
//! the relays, and the relays keep carrying everything, so the phone falls
//! back to them whenever no direct endpoint answers. Both sides already drop
//! an event they have seen by its id, so an event arriving both ways is
//! handled once.
//!
//! Each frame is one WebSocket text message, a JSON array:
//!
//! ```text
//! bridge → phone  ["CHALLENGE", <challenge>]            on connect
//! phone  → bridge ["HELLO", <auth event>, <since>]      auth: kind 22242,
//!                                                       signed by the identity,
//!                                                       tagged ["challenge", c]
//! bridge → phone  ["READY"] | ["CLOSED", <reason>]
//! both            ["EVENT", <signed event>]
//! bridge → phone  ["OK", <event id>, <accepted>, <message>]
//! ```
//!
//! After `READY` the bridge sends the events it published for that identity
//! since `since` (seconds; it keeps [`OUTBOX_SECS`] of them), then new ones
//! as it publishes them. It answers each phone `EVENT` with an `OK`.
//!
//! Where to connect rides the bridge's heartbeat ([`DirectInfo`]), which the
//! bridge signs and encrypts to the phone: a `wss://` endpoint serves a
//! self-signed certificate the phone pins by [`DirectInfo::cert_sha256`];
//! `ws://` is only for `.onion` endpoints.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::nostr_event::SignedEvent;

/// The kind of the `HELLO` auth event (the NIP-42 AUTH kind).
pub const DIRECT_AUTH_KIND: u16 = 22242;
/// How far a `HELLO` auth event's `created_at` may be from the bridge's clock.
pub const AUTH_MAX_SKEW_SECS: u64 = 600;
/// How long the bridge keeps what it published, for a phone resuming.
pub const OUTBOX_SECS: u64 = 3600;

/// How to reach a bridge directly, as its heartbeat advertises it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DirectInfo {
    /// `wss://host:port` or `ws://<name>.onion:port`, in the order to try.
    pub endpoints: Vec<String>,
    /// SHA-256 of the DER certificate `wss://` endpoints serve, lowercase
    /// hex. Absent when the bridge serves no `wss://` endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_sha256: Option<String>,
}

/// One frame on the direct link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectFrame {
    Challenge(String),
    Hello { auth: SignedEvent, since: u64 },
    Ready,
    Closed(String),
    Event(SignedEvent),
    Ok { id: String, accepted: bool, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("bad direct frame: {0}")]
pub struct DirectDecodeError(pub String);

pub fn encode_direct_frame(frame: &DirectFrame) -> String {
    let value = match frame {
        DirectFrame::Challenge(c) => json!(["CHALLENGE", c]),
        DirectFrame::Hello { auth, since } => json!(["HELLO", auth, since]),
        DirectFrame::Ready => json!(["READY"]),
        DirectFrame::Closed(reason) => json!(["CLOSED", reason]),
        DirectFrame::Event(event) => json!(["EVENT", event]),
        DirectFrame::Ok { id, accepted, message } => json!(["OK", id, accepted, message]),
    };
    value.to_string()
}

/// Decode one frame. Total: anything malformed is an error, never a panic.
pub fn decode_direct_frame(text: &str) -> Result<DirectFrame, DirectDecodeError> {
    let bad = |why: &str| DirectDecodeError(why.to_string());
    let value: Value = serde_json::from_str(text).map_err(|e| bad(&e.to_string()))?;
    let items = value.as_array().ok_or_else(|| bad("not an array"))?;
    let label = items.first().and_then(Value::as_str).ok_or_else(|| bad("no label"))?;
    let string = |i: usize| items.get(i).and_then(Value::as_str).map(str::to_string);
    let event = |i: usize| {
        items
            .get(i)
            .and_then(|v| serde_json::from_value::<SignedEvent>(v.clone()).ok())
            .ok_or_else(|| bad("bad event"))
    };
    let arity = |n: usize| if items.len() == n { Ok(()) } else { Err(bad("wrong length")) };
    match label {
        "CHALLENGE" => {
            arity(2)?;
            Ok(DirectFrame::Challenge(string(1).ok_or_else(|| bad("bad challenge"))?))
        }
        "HELLO" => {
            arity(3)?;
            let since = items.get(2).and_then(Value::as_u64).ok_or_else(|| bad("bad since"))?;
            Ok(DirectFrame::Hello { auth: event(1)?, since })
        }
        "READY" => {
            arity(1)?;
            Ok(DirectFrame::Ready)
        }
        "CLOSED" => {
            arity(2)?;
            Ok(DirectFrame::Closed(string(1).ok_or_else(|| bad("bad reason"))?))
        }
        "EVENT" => {
            arity(2)?;
            Ok(DirectFrame::Event(event(1)?))
        }
        "OK" => {
            arity(4)?;
            Ok(DirectFrame::Ok {
                id: string(1).ok_or_else(|| bad("bad id"))?,
                accepted: items.get(2).and_then(Value::as_bool).ok_or_else(|| bad("bad accepted"))?,
                message: string(3).ok_or_else(|| bad("bad message"))?,
            })
        }
        _ => Err(bad("unknown label")),
    }
}

/// Whether `event` is correctly signed: its id is the hash of its content
/// and its signature is its author's.
pub fn event_is_valid(event: &SignedEvent) -> bool {
    let Ok(json) = serde_json::to_string(event) else { return false };
    <nostr::Event as nostr::JsonUtil>::from_json(json).is_ok_and(|e| e.verify().is_ok())
}

/// Why a `HELLO` auth event was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DirectAuthError {
    #[error("not an auth event")]
    WrongKind,
    #[error("answers another challenge")]
    WrongChallenge,
    #[error("too old or too far ahead")]
    Stale,
    #[error("bad signature")]
    BadSignature,
}

/// Check the `HELLO` auth event against the `challenge` this connection was
/// sent; returns the pubkey it proves. Whether that pubkey is a paired
/// phone is the caller's.
pub fn check_direct_auth(auth: &SignedEvent, challenge: &str, now_secs: u64) -> Result<String, DirectAuthError> {
    if auth.kind != DIRECT_AUTH_KIND {
        return Err(DirectAuthError::WrongKind);
    }
    let answered = auth
        .tags
        .iter()
        .any(|t| t.first().map(String::as_str) == Some("challenge") && t.get(1).map(String::as_str) == Some(challenge));
    if !answered {
        return Err(DirectAuthError::WrongChallenge);
    }
    if auth.created_at.abs_diff(now_secs) > AUTH_MAX_SKEW_SECS {
        return Err(DirectAuthError::Stale);
    }
    if !event_is_valid(auth) {
        return Err(DirectAuthError::BadSignature);
    }
    Ok(auth.pubkey.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::generate_keypair;
    use crate::nip42::build_auth_event;

    const NOW: u64 = 1_800_000_000;

    #[test]
    fn frames_round_trip() {
        let id = generate_keypair();
        let auth = build_auth_event(&id, "wss://10.0.0.2:7447", "c1", NOW * 1000).unwrap();
        for frame in [
            DirectFrame::Challenge("c1".into()),
            DirectFrame::Hello { auth: auth.clone(), since: NOW - 60 },
            DirectFrame::Ready,
            DirectFrame::Closed("not paired".into()),
            DirectFrame::Event(auth.clone()),
            DirectFrame::Ok { id: auth.id.clone(), accepted: true, message: String::new() },
        ] {
            assert_eq!(decode_direct_frame(&encode_direct_frame(&frame)), Ok(frame));
        }
    }

    #[test]
    fn a_valid_auth_proves_its_pubkey() {
        let id = generate_keypair();
        let auth = build_auth_event(&id, "wss://10.0.0.2:7447", "c1", NOW * 1000).unwrap();
        assert_eq!(check_direct_auth(&auth, "c1", NOW + 30), Ok(id.pubkey_hex.clone()));
        assert_eq!(check_direct_auth(&auth, "c2", NOW), Err(DirectAuthError::WrongChallenge));
        assert_eq!(check_direct_auth(&auth, "c1", NOW + AUTH_MAX_SKEW_SECS + 1), Err(DirectAuthError::Stale));
        let mut forged = auth.clone();
        forged.pubkey = generate_keypair().pubkey_hex;
        assert_eq!(check_direct_auth(&forged, "c1", NOW), Err(DirectAuthError::BadSignature));
        let mut other = auth;
        other.kind = 1;
        assert_eq!(check_direct_auth(&other, "c1", NOW), Err(DirectAuthError::WrongKind));
    }
}
