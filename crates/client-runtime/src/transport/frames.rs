//! The Nostr relay wire protocol, client side — a pure codec for the ten frame
//! shapes a client exchanges with a relay. No sockets: [`super::WsTransport`]
//! owns those and calls these to translate.
//!
//! Inbound (relay → client): `EVENT` `EOSE` `CLOSED` `OK` `NOTICE` `AUTH`.
//! Outbound (client → relay): `REQ` `CLOSE` `EVENT` `AUTH`.
//!
//! Parsing is lenient in one direction only: an unrecognised verb (a relay
//! sending `COUNT`, a future frame) is [`RelayMessage::Unknown`], not an error —
//! the read loop ignores it rather than dropping the socket. A malformed known
//! frame *is* an error, so the caller can log it.

use protocol::nostr_event::SignedEvent;
use serde_json::{json, Value};

use crate::nostr_client::Filter;

/// One parsed relay → client frame.
#[derive(Debug, Clone, PartialEq)]
pub enum RelayMessage {
    /// `["EVENT", <sub_id>, <event>]` — `event` is the raw object, verified and
    /// projected by the caller.
    Event { sub_id: String, event: Value },
    /// `["EOSE", <sub_id>]` — end of stored events for this subscription.
    Eose { sub_id: String },
    /// `["CLOSED", <sub_id>, <message>]` — the relay ended the subscription
    /// (e.g. `auth-required:`, `rate-limited:`).
    Closed { sub_id: String, message: String },
    /// `["OK", <event_id>, <accepted>, <message>]` — the verdict on a publish.
    Ok {
        event_id: String,
        accepted: bool,
        message: String,
    },
    /// `["NOTICE", <message>]` — a human-readable relay message.
    Notice { message: String },
    /// `["AUTH", <challenge>]` — a NIP-42 challenge to answer.
    Auth { challenge: String },
    /// A verb this client does not model. Ignored by the read loop.
    Unknown { verb: String },
}

fn str_at(arr: &[Value], i: usize, verb: &str) -> Result<String, String> {
    arr.get(i)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{verb}: missing string at [{i}]"))
}

/// Parse one relay text frame. `Err` on a malformed known verb; an unknown verb
/// is [`RelayMessage::Unknown`].
pub fn parse_relay_message(text: &str) -> Result<RelayMessage, String> {
    let arr: Vec<Value> =
        serde_json::from_str(text).map_err(|e| format!("not a JSON array: {e}"))?;
    let verb = arr
        .first()
        .and_then(Value::as_str)
        .ok_or("frame has no string verb")?;

    match verb {
        "EVENT" => {
            let sub_id = str_at(&arr, 1, "EVENT")?;
            let event = arr.get(2).cloned().ok_or("EVENT: missing event")?;
            if !event.is_object() {
                return Err("EVENT: event is not an object".to_string());
            }
            Ok(RelayMessage::Event { sub_id, event })
        }
        "EOSE" => Ok(RelayMessage::Eose {
            sub_id: str_at(&arr, 1, "EOSE")?,
        }),
        "CLOSED" => Ok(RelayMessage::Closed {
            sub_id: str_at(&arr, 1, "CLOSED")?,
            message: arr.get(2).and_then(Value::as_str).unwrap_or_default().to_string(),
        }),
        "OK" => Ok(RelayMessage::Ok {
            event_id: str_at(&arr, 1, "OK")?,
            accepted: arr
                .get(2)
                .and_then(Value::as_bool)
                .ok_or("OK: missing accepted bool at [2]")?,
            message: arr.get(3).and_then(Value::as_str).unwrap_or_default().to_string(),
        }),
        "NOTICE" => Ok(RelayMessage::Notice {
            message: arr.get(1).and_then(Value::as_str).unwrap_or_default().to_string(),
        }),
        "AUTH" => Ok(RelayMessage::Auth {
            challenge: str_at(&arr, 1, "AUTH")?,
        }),
        other => Ok(RelayMessage::Unknown {
            verb: other.to_string(),
        }),
    }
}

/// The relay-JSON form of a [`Filter`]. Empty vecs and an absent `since` are
/// omitted so the filter is minimal (and matches what the TS SimplePool sends).
pub fn filter_to_json(filter: &Filter) -> Value {
    let mut map = serde_json::Map::new();
    if !filter.kinds.is_empty() {
        map.insert("kinds".to_string(), json!(filter.kinds));
    }
    if !filter.authors.is_empty() {
        map.insert("authors".to_string(), json!(filter.authors));
    }
    if !filter.p_tags.is_empty() {
        map.insert("#p".to_string(), json!(filter.p_tags));
    }
    if !filter.h_tags.is_empty() {
        map.insert("#h".to_string(), json!(filter.h_tags));
    }
    if let Some(since) = filter.since {
        map.insert("since".to_string(), json!(since));
    }
    Value::Object(map)
}

/// `["REQ", <sub_id>, <filter>, …]`.
pub fn req_frame(sub_id: &str, filters: &[Value]) -> String {
    let mut arr = Vec::with_capacity(2 + filters.len());
    arr.push(json!("REQ"));
    arr.push(json!(sub_id));
    arr.extend(filters.iter().cloned());
    Value::Array(arr).to_string()
}

/// `["CLOSE", <sub_id>]`.
pub fn close_frame(sub_id: &str) -> String {
    json!(["CLOSE", sub_id]).to_string()
}

/// `["EVENT", <event>]` — publish.
pub fn event_frame(event: &SignedEvent) -> String {
    json!(["EVENT", serde_json::to_value(event).expect("SignedEvent serializes")]).to_string()
}

/// `["AUTH", <event>]` — the answer to a NIP-42 challenge.
pub fn auth_frame(event: &SignedEvent) -> String {
    json!(["AUTH", serde_json::to_value(event).expect("SignedEvent serializes")]).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_event_with_its_object() {
        let raw = r#"["EVENT","sub-1",{"id":"aa","kind":24515,"pubkey":"bb","content":"x","tags":[],"created_at":1,"sig":"cc"}]"#;
        match parse_relay_message(raw).unwrap() {
            RelayMessage::Event { sub_id, event } => {
                assert_eq!(sub_id, "sub-1");
                assert_eq!(event["kind"], 24515);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_eose_closed_ok_notice_auth() {
        assert_eq!(
            parse_relay_message(r#"["EOSE","s"]"#).unwrap(),
            RelayMessage::Eose { sub_id: "s".into() }
        );
        assert_eq!(
            parse_relay_message(r#"["CLOSED","s","auth-required: nope"]"#).unwrap(),
            RelayMessage::Closed { sub_id: "s".into(), message: "auth-required: nope".into() }
        );
        assert_eq!(
            parse_relay_message(r#"["CLOSED","s"]"#).unwrap(),
            RelayMessage::Closed { sub_id: "s".into(), message: String::new() }
        );
        assert_eq!(
            parse_relay_message(r#"["OK","evt-id",true,""]"#).unwrap(),
            RelayMessage::Ok { event_id: "evt-id".into(), accepted: true, message: String::new() }
        );
        assert_eq!(
            parse_relay_message(r#"["OK","evt-id",false,"rate-limited: slow down"]"#).unwrap(),
            RelayMessage::Ok {
                event_id: "evt-id".into(),
                accepted: false,
                message: "rate-limited: slow down".into(),
            }
        );
        assert_eq!(
            parse_relay_message(r#"["NOTICE","hello"]"#).unwrap(),
            RelayMessage::Notice { message: "hello".into() }
        );
        assert_eq!(
            parse_relay_message(r#"["AUTH","challenge-xyz"]"#).unwrap(),
            RelayMessage::Auth { challenge: "challenge-xyz".into() }
        );
    }

    #[test]
    fn an_unknown_verb_is_not_an_error() {
        assert_eq!(
            parse_relay_message(r#"["COUNT","s",{"count":3}]"#).unwrap(),
            RelayMessage::Unknown { verb: "COUNT".into() }
        );
    }

    #[test]
    fn malformed_frames_are_errors() {
        assert!(parse_relay_message("not json").is_err());
        assert!(parse_relay_message(r#"{"not":"an array"}"#).is_err());
        assert!(parse_relay_message(r#"[123,"s"]"#).is_err()); // non-string verb
        assert!(parse_relay_message(r#"["EVENT","s"]"#).is_err()); // no event
        assert!(parse_relay_message(r#"["EVENT","s","not-an-object"]"#).is_err());
        assert!(parse_relay_message(r#"["EOSE"]"#).is_err()); // no sub id
        assert!(parse_relay_message(r#"["OK","id","not-bool",""]"#).is_err());
    }

    #[test]
    fn filter_json_omits_empty_and_absent_fields() {
        let full = Filter {
            kinds: vec![4516],
            authors: vec!["a1".into()],
            p_tags: vec!["p1".into()],
            h_tags: vec!["h1".into()],
            since: Some(1000),
        };
        assert_eq!(
            filter_to_json(&full),
            json!({ "kinds": [4516], "authors": ["a1"], "#p": ["p1"], "#h": ["h1"], "since": 1000 })
        );

        let no_since = Filter {
            kinds: vec![30515],
            authors: vec!["a1".into()],
            p_tags: vec!["p1".into()],
            h_tags: Vec::new(),
            since: None,
        };
        let v = filter_to_json(&no_since);
        assert!(v.get("since").is_none());
        assert_eq!(v["kinds"], json!([30515]));

        let empty = Filter { kinds: vec![], authors: vec![], p_tags: vec![], h_tags: vec![], since: None };
        assert_eq!(filter_to_json(&empty), json!({}));
    }

    #[test]
    fn req_frame_carries_sub_id_then_filters() {
        let f1 = json!({ "kinds": [1] });
        let f2 = json!({ "kinds": [2] });
        let raw = req_frame("sub-9", &[f1.clone(), f2.clone()]);
        let parsed: Vec<Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed[0], "REQ");
        assert_eq!(parsed[1], "sub-9");
        assert_eq!(parsed[2], f1);
        assert_eq!(parsed[3], f2);
    }

    #[test]
    fn close_frame_shape() {
        assert_eq!(close_frame("s"), r#"["CLOSE","s"]"#);
    }

    fn a_signed_event() -> SignedEvent {
        SignedEvent {
            id: "id1".into(),
            pubkey: "pk1".into(),
            created_at: 42,
            kind: 4515,
            tags: vec![vec!["p".into(), "mac".into()]],
            content: "ciphertext".into(),
            sig: "sig1".into(),
        }
    }

    #[test]
    fn event_and_auth_frames_carry_the_full_event_object() {
        let ev = a_signed_event();
        for (raw, verb) in [(event_frame(&ev), "EVENT"), (auth_frame(&ev), "AUTH")] {
            let parsed: Vec<Value> = serde_json::from_str(&raw).unwrap();
            assert_eq!(parsed[0], verb);
            let obj = &parsed[1];
            assert_eq!(obj["id"], "id1");
            assert_eq!(obj["kind"], 4515);
            assert_eq!(obj["content"], "ciphertext");
            assert_eq!(obj["tags"], json!([["p", "mac"]]));
            assert_eq!(obj["sig"], "sig1");
            assert_eq!(obj["created_at"], 42);
        }
    }
}
