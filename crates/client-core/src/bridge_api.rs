//! Phone → bridge request/response plumbing — the pure half of
//! `apps/mobile/src/core/services/bridgeApi.ts`.
//!
//! Plan §6.2 splits `bridgeApi.ts` in two: the **policy** (which kind a command
//! rides, egress validation, version stamping) and the **ingest pipeline**
//! (decrypt → reassemble → decode) are pure and live here; the socket I/O (the
//! actual publish, the `publishConfirmed` retry loop, folder-ack timers, handler
//! dispatch) lives in `client-runtime`.
//!
//! Two guarantees carried over verbatim from the TS:
//!
//! * [`build_command`] returns ONE signed event. A retry must re-publish that
//!   exact value — calling `build_command` again stamps a fresh `created_at` and
//!   NIP-44 nonce, so the id changes, the bridge's id-based dedup cannot help,
//!   and an image gets injected twice (CDX-086).
//! * [`BridgeApi::ingest`] is total: a bad payload is a returned variant plus a
//!   diagnostics bump, never a panic and never a fake disconnect. A NIP-44
//!   decrypt failure from a known machine is reported to the connection FSM as a
//!   diagnostic (`needsPairingCheck`), not a socket close.

use std::collections::HashSet;

use nostr::key::{Keys, PublicKey};
use nostr::{EventBuilder, Kind, Tag, Timestamp};

use protocol::chunking::{AssemblerResult, ChunkAssembler};
use protocol::crypto::{decrypt_from, encrypt_to, CryptoError, Keypair};
use protocol::nostr_event::SignedEvent;
use protocol::capabilities::{ALL_PHONE_CAPABILITIES, PROTOCOL_VERSION};
use protocol::codec::encode_phone_to_bridge;
use protocol::commands::PhoneToBridge;
use protocol::events::BridgeToPhone;
use protocol::kinds::{COMMAND_EXPIRY_SECONDS, COMMAND_KIND};

/// Most-recent invalid-payload records kept for diagnostics (older ones drop).
const INVALID_RECORDS_CAP: usize = 100;

// --- Outbound: policy + egress -------------------------------------------------

/// Which Nostr kind a phone→bridge command rides.
///
/// Unlike bridge→phone traffic — split three ways by storage class, see
/// `client_runtime::nostr_client` — every phone→bridge command is a stored
/// [`COMMAND_KIND`] event: a briefly-offline bridge still receives it on
/// resubscribe, and NIP-40 expires it after [`COMMAND_EXPIRY_SECONDS`]. This
/// function is the single place that policy is stated.
pub fn kind_for_message(_msg: &PhoneToBridge) -> u16 {
    COMMAND_KIND
}

/// Stamp `v` + `caps` onto an already-encoded command, mirroring the TS
/// `{ v, caps, ...msg }` spread: the sender's [`PROTOCOL_VERSION`] and the
/// caps it can RENDER ([`ALL_PHONE_CAPABILITIES`]) so the bridge can gate entry
/// kinds an older phone would hard-fail on (CDX-050). A field the message
/// already carries is left untouched.
fn stamp_command(encoded: &str) -> String {
    let mut value: serde_json::Value =
        serde_json::from_str(encoded).expect("encode_phone_to_bridge emits a JSON object");
    let obj = value
        .as_object_mut()
        .expect("encode_phone_to_bridge emits a JSON object");
    obj.entry("v")
        .or_insert_with(|| serde_json::Value::from(PROTOCOL_VERSION));
    obj.entry("caps").or_insert_with(|| {
        serde_json::to_value(ALL_PHONE_CAPABILITIES).expect("caps array serializes")
    });
    serde_json::to_string(&value).expect("stamped command re-serializes")
}

/// Why a command could not be built. Every variant is a caller error surfaced at
/// the sender rather than a silent bad publish.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EgressError {
    /// Egress validation rejected the message (e.g. CDX-071: a
    /// `set-provider-profile` whose `baseUrl` is not https / http-on-loopback).
    #[error("egress validation failed: {0}")]
    Invalid(String),
    /// The recipient pubkey or our own key was unusable.
    #[error("crypto: {0}")]
    Crypto(#[from] CryptoError),
    /// Schnorr signing failed (should not happen with a valid identity key).
    #[error("sign: {0}")]
    Sign(String),
}

/// Encode (egress-validated), version-stamp, NIP-44-encrypt, and sign one
/// phone→bridge command as a [`COMMAND_KIND`] event carrying `["p", machine]`
/// and a NIP-40 `["expiration", …]` tag.
///
/// The returned [`SignedEvent`] is what the caller must re-publish verbatim on
/// retry — see the module docs (CDX-086).
///
/// `now_ms` is injected wall-clock in milliseconds; `created_at` is
/// `now_ms / 1000`, matching the TS `Math.floor(now() / 1000)`.
pub fn build_command(
    identity: &Keypair,
    machine_pubkey_hex: &str,
    msg: &PhoneToBridge,
    now_ms: u64,
) -> Result<SignedEvent, EgressError> {
    let encoded = encode_phone_to_bridge(msg).map_err(EgressError::Invalid)?;
    let stamped = stamp_command(&encoded);

    let machine_pk =
        PublicKey::from_hex(machine_pubkey_hex).map_err(|_| CryptoError::InvalidKey)?;
    let content = encrypt_to(&identity.secret_key, machine_pubkey_hex, &stamped)?;

    let created_at = now_ms / 1000;
    let expiration = created_at + COMMAND_EXPIRY_SECONDS;
    let keys = Keys::new(identity.secret_key.clone());

    let event = EventBuilder::new(Kind::Custom(kind_for_message(msg)), content)
        .tags([
            Tag::public_key(machine_pk),
            Tag::expiration(Timestamp::from(expiration)),
        ])
        .custom_created_at(Timestamp::from(created_at))
        .sign_with_keys(&keys)
        .map_err(|e| EgressError::Sign(e.to_string()))?;

    Ok(SignedEvent::from_nostr(&event))
}

// --- Outbound: publish verdict (CDX-086) -------------------------------------

/// What actually happened to a publish. The boolean this replaces collapsed two
/// opposite outcomes into `false` and got one of them backwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishVerdict {
    /// A relay returned OK — delivered, confirmed.
    Accepted,
    /// The frame WAS written to an open socket but no OK arrived in the publish
    /// timeout. Very probably delivered; treating it as failure is the
    /// stuck-upload bug.
    Unconfirmed,
    /// A relay refused (`rate-limited:`, `blocked:`, `pow:`). Retrying the same
    /// event will not help.
    Rejected,
    /// No relay could even be reached.
    Unreachable,
}

impl PublishVerdict {
    /// Severity — the softest surviving verdict across relays wins (CDX-086).
    fn rank(self) -> u8 {
        match self {
            Self::Accepted => 0,
            Self::Unconfirmed => 1,
            Self::Rejected => 2,
            Self::Unreachable => 3,
        }
    }

    /// `accepted` and `unconfirmed` both mean the bridge has it (or almost
    /// certainly does) — the frame reached an open socket.
    pub fn is_delivered(self) -> bool {
        matches!(self, Self::Accepted | Self::Unconfirmed)
    }
}

/// One relay's publish outcome plus any relay-reported reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishResult {
    pub verdict: PublishVerdict,
    pub detail: Option<String>,
}

fn detail_of(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Classify ONE relay's publish outcome (CDX-086). `Ok(reason)` is the relay's
/// OK message (usually empty); `Err(msg)` is a rejection or timeout string.
///
/// - `Ok("connection failure: …")` — the relay could not be reached at all. The
///   transport resolves rather than rejects these, which is why the old boolean
///   reported an unreachable relay as success.
/// - `Err("… publish timed out …")` — the frame WAS written to an open socket
///   but no OK arrived inside the publish timeout. Very probably delivered.
/// - any other `Err` — the relay refused the event.
pub fn classify_publish(outcome: Result<&str, &str>) -> PublishResult {
    match outcome {
        Ok(value) => {
            if value.to_ascii_lowercase().starts_with("connection failure:") {
                PublishResult {
                    verdict: PublishVerdict::Unreachable,
                    detail: Some(value.to_string()),
                }
            } else {
                PublishResult {
                    verdict: PublishVerdict::Accepted,
                    detail: detail_of(value),
                }
            }
        }
        Err(reason) => {
            if reason.to_ascii_lowercase().contains("publish timed out") {
                PublishResult {
                    verdict: PublishVerdict::Unconfirmed,
                    detail: Some(reason.to_string()),
                }
            } else {
                PublishResult {
                    verdict: PublishVerdict::Rejected,
                    detail: Some(reason.to_string()),
                }
            }
        }
    }
}

/// Combine per-relay results into the verdict for the publish — the softest
/// surviving verdict wins (CDX-086). An empty slice is `unreachable`.
pub fn combine_publish(results: &[PublishResult]) -> PublishResult {
    results
        .iter()
        .min_by_key(|r| r.verdict.rank())
        .cloned()
        .unwrap_or(PublishResult {
            verdict: PublishVerdict::Unreachable,
            detail: Some("no relay settled".to_string()),
        })
}

// --- Inbound: the ingest pipeline -------------------------------------------

/// The stage at which a payload was found invalid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidStage {
    Decrypt,
    Decode,
}

/// A dropped payload, kept for diagnostics (capped at [`INVALID_RECORDS_CAP`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidPayloadRecord {
    pub event_id: String,
    pub machine: String,
    pub kind: u16,
    pub stage: InvalidStage,
    pub error: String,
}

/// Running counts + recent invalid payloads. Read by the connection FSM
/// (`needsPairingCheck`) and the diagnostics UI.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct BridgeApiDiagnostics {
    pub decrypt_failures: u64,
    pub decode_failures: u64,
    pub invalid: Vec<InvalidPayloadRecord>,
}

/// The fields of a relay event [`BridgeApi::ingest`] needs. The runtime fills
/// this from the live transport event.
#[derive(Debug, Clone, Copy)]
pub struct IncomingEvent<'a> {
    /// Event id, for the invalid-payload record only.
    pub id: &'a str,
    /// Event author = the bridge machine's pubkey (hex).
    pub pubkey: &'a str,
    pub kind: u16,
    /// `event.content`: `base64(NIP-44(json))`, or a `chunk` fragment envelope.
    pub content: &'a str,
}

/// What `ingest` decided about one event. Total — a bad payload is a variant,
/// never a panic.
#[derive(Debug, Clone, PartialEq)]
pub enum Ingested {
    /// Author is not a paired machine / pairing candidate — dropped silently.
    UnknownMachine,
    /// NIP-44 decrypt failed. The runtime reports this to the connection FSM as
    /// a diagnostic — NEVER a disconnect.
    DecryptFailed,
    /// A `chunk` fragment was buffered; its message is not complete yet.
    Buffered,
    /// The plaintext (whole or reassembled) is not a valid bridge→phone message.
    DecodeFailed,
    /// A decoded message for the runtime to dispatch to the handlers.
    Message(Box<BridgeToPhone>),
}

/// The stateful half of the inbound path: the oversize-message reassembler, the
/// diagnostics counters, and the set of outstanding `create-folder` request ids.
///
/// Not `Sync` in intent — one instance per connection, driven from the runtime's
/// single ingest task.
#[derive(Debug)]
pub struct BridgeApi {
    reassembler: ChunkAssembler,
    diagnostics: BridgeApiDiagnostics,
    pending_folder_acks: HashSet<String>,
    folder_request_counter: u64,
}

impl Default for BridgeApi {
    fn default() -> Self {
        Self::new()
    }
}

impl BridgeApi {
    pub fn new() -> Self {
        Self {
            reassembler: ChunkAssembler::new(),
            diagnostics: BridgeApiDiagnostics::default(),
            pending_folder_acks: HashSet::new(),
            folder_request_counter: 0,
        }
    }

    pub fn diagnostics(&self) -> &BridgeApiDiagnostics {
        &self.diagnostics
    }

    /// Ingest one relay event. Never throws; mutates only the reassembler and the
    /// diagnostics.
    ///
    /// `is_known_machine` is decided by the runtime against the paired-machine
    /// list + active pairing candidate. `now_ms` drives the reassembler's TTL
    /// sweep.
    pub fn ingest(
        &mut self,
        event: &IncomingEvent<'_>,
        identity: &Keypair,
        is_known_machine: bool,
        now_ms: u64,
    ) -> Ingested {
        if !is_known_machine {
            return Ingested::UnknownMachine;
        }

        let plaintext = match decrypt_from(&identity.secret_key, event.pubkey, event.content) {
            Ok(text) => text,
            Err(err) => {
                self.record_invalid(event, InvalidStage::Decrypt, err.to_string());
                self.diagnostics.decrypt_failures += 1;
                return Ingested::DecryptFailed;
            }
        };

        // Oversize-message reassembly. A plaintext that is not a `chunk` envelope
        // passes straight through; a fragment is buffered until its group
        // completes, then the reassembled JSON takes its place.
        let plaintext = match self.reassembler.offer(&plaintext, now_ms) {
            AssemblerResult::Passthrough => plaintext,
            AssemblerResult::Buffered => return Ingested::Buffered,
            AssemblerResult::Assembled { json } => json,
            AssemblerResult::Invalid { error } => {
                self.record_invalid(event, InvalidStage::Decode, format!("chunk: {error}"));
                self.diagnostics.decode_failures += 1;
                return Ingested::DecodeFailed;
            }
        };

        match protocol::codec::decode_bridge_to_phone(&plaintext) {
            Ok(msg) => Ingested::Message(Box::new(msg)),
            Err(error) => {
                self.record_invalid(event, InvalidStage::Decode, error);
                self.diagnostics.decode_failures += 1;
                Ingested::DecodeFailed
            }
        }
    }

    /// Allocate a `create-folder` request id and remember it as outstanding.
    /// Mirrors the TS `folder-${n}-${now}` scheme; the runtime pairs the id with
    /// a timeout timer and the caller's promise.
    pub fn next_folder_request_id(&mut self, now_ms: u64) -> String {
        self.folder_request_counter += 1;
        let id = format!("folder-{}-{now_ms}", self.folder_request_counter);
        self.pending_folder_acks.insert(id.clone());
        id
    }

    /// Consume an outstanding `create-folder` id (on its `folder-ack` or its
    /// timeout). `true` if it was still outstanding.
    pub fn take_pending_folder_ack(&mut self, request_id: &str) -> bool {
        self.pending_folder_acks.remove(request_id)
    }

    /// Outstanding `create-folder` request count — diagnostics / tests.
    pub fn pending_folder_ack_count(&self) -> usize {
        self.pending_folder_acks.len()
    }

    fn record_invalid(&mut self, event: &IncomingEvent<'_>, stage: InvalidStage, error: String) {
        self.diagnostics.invalid.push(InvalidPayloadRecord {
            event_id: event.id.to_string(),
            machine: event.pubkey.to_string(),
            kind: event.kind,
            stage,
            error,
        });
        if self.diagnostics.invalid.len() > INVALID_RECORDS_CAP {
            self.diagnostics.invalid.remove(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::chunking::frame_encoded_message;
    use protocol::crypto::{generate_keypair, keypair_from_secret_hex};
    use protocol::codec::{decode_bridge_to_phone, decode_phone_to_bridge, encode_bridge_to_phone};
    use serde_json::json;

    const SEC_PHONE: &str =
        "0000000000000000000000000000000000000000000000000000000000000001";
    const SEC_MACHINE: &str =
        "0000000000000000000000000000000000000000000000000000000000000002";

    fn phone() -> Keypair {
        keypair_from_secret_hex(SEC_PHONE).unwrap()
    }
    fn machine() -> Keypair {
        keypair_from_secret_hex(SEC_MACHINE).unwrap()
    }

    /// One encrypted event carrying `payload` (a whole message or one fragment),
    /// authored by `from` for `to`.
    fn event_content(payload: &str, from: &Keypair, to: &Keypair) -> String {
        encrypt_to(&from.secret_key, &to.pubkey_hex, payload).unwrap()
    }

    fn incoming<'a>(content: &'a str, author: &'a str) -> IncomingEvent<'a> {
        IncomingEvent {
            id: "evt-1",
            pubkey: author,
            kind: protocol::kinds::LIVE_KIND,
            content,
        }
    }

    /// Wire bytes for an `output` message with an `entry.content` of `bytes`
    /// chars (mirrors `encodeBridgeToPhone(bigOutput(...))`).
    fn big_output_wire(bytes: usize, seq: u64) -> (BridgeToPhone, String) {
        let msg = decode_bridge_to_phone(
            &json!({
                "type": "output",
                "sessionId": "s1",
                "seq": seq,
                "entry": {
                    "entryType": "text",
                    "content": "Z".repeat(bytes),
                    "timestamp": "2026-08-05T00:00:00.000Z",
                    "metadata": { "role": "assistant" },
                },
            })
            .to_string(),
        )
        .unwrap();
        let wire = encode_bridge_to_phone(&msg);
        (msg, wire)
    }

    fn deliver(api: &mut BridgeApi, id: &Keypair, mac: &Keypair, content: &str) -> Ingested {
        api.ingest(&incoming(content, &mac.pubkey_hex), id, true, 1_000_000)
    }

    // --- outbound -----------------------------------------------------------

    #[test]
    fn kind_for_message_is_always_command_kind() {
        let msg =
            decode_phone_to_bridge(r#"{"type":"input","sessionId":"s","text":"hi"}"#).unwrap();
        assert_eq!(kind_for_message(&msg), COMMAND_KIND);
    }

    #[test]
    fn build_command_stamps_version_and_caps_and_shapes_the_event() {
        let (id, mac) = (phone(), machine());
        let msg =
            decode_phone_to_bridge(r#"{"type":"input","sessionId":"s1","text":"hello"}"#).unwrap();

        let cmd = build_command(&id, &mac.pubkey_hex, &msg, 1_700_000_000_000).unwrap();

        assert_eq!(cmd.kind, COMMAND_KIND);
        assert_eq!(cmd.pubkey, id.pubkey_hex);
        assert_eq!(cmd.created_at, 1_700_000_000);
        assert!(cmd.tags.contains(&vec!["p".to_string(), mac.pubkey_hex.clone()]));
        assert!(cmd.tags.iter().any(|t| t[0] == "expiration"
            && t[1] == (1_700_000_000 + COMMAND_EXPIRY_SECONDS).to_string()));

        // The bridge decrypts the content with the conversation key.
        let plaintext = decrypt_from(&mac.secret_key, &id.pubkey_hex, &cmd.content).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&plaintext).unwrap();
        assert_eq!(payload["v"], json!(PROTOCOL_VERSION));
        assert_eq!(payload["caps"], json!(["diff", "chunked"]));
        assert_eq!(payload["type"], "input");
        assert_eq!(payload["text"], "hello");
    }

    #[test]
    fn build_command_upload_image_blossom_payload_round_trips() {
        let (id, mac) = (phone(), machine());
        let msg = decode_phone_to_bridge(
            &json!({
                "type": "upload-image",
                "sessionId": "s1",
                "hash": "c".repeat(64),
                "url": format!("https://blossom.example/{}", "c".repeat(64)),
                "key": "a".repeat(64),
                "iv": "b".repeat(24),
                "filename": "shot.png",
                "mimeType": "image/png",
                "text": "look at this",
                "sizeBytes": 1234,
            })
            .to_string(),
        )
        .unwrap();

        let cmd = build_command(&id, &mac.pubkey_hex, &msg, 1_000).unwrap();
        assert_eq!(cmd.kind, COMMAND_KIND);

        let plaintext = decrypt_from(&mac.secret_key, &id.pubkey_hex, &cmd.content).unwrap();
        let decoded = decode_phone_to_bridge(&plaintext).unwrap();
        match decoded {
            PhoneToBridge::UploadImage(protocol::commands::UploadImageMsg::Blossom(b)) => {
                assert_eq!(b.hash, "c".repeat(64));
                assert_eq!(b.key, "a".repeat(64));
                assert_eq!(b.iv, "b".repeat(24));
                assert_eq!(b.text, "look at this");
                assert_eq!(b.version.v, Some(PROTOCOL_VERSION));
            }
            other => panic!("expected blossom upload-image, got {other:?}"),
        }
    }

    #[test]
    fn build_command_upload_image_chunk_payload_round_trips() {
        let (id, mac) = (phone(), machine());
        let msg = decode_phone_to_bridge(
            &json!({
                "type": "upload-image",
                "sessionId": "s1",
                "uploadId": "u-1",
                "filename": "shot.png",
                "mimeType": "image/png",
                "base64Data": "AAAA",
                "text": "first chunk carries the text",
                "chunkIndex": 0,
                "totalChunks": 3,
            })
            .to_string(),
        )
        .unwrap();

        let cmd = build_command(&id, &mac.pubkey_hex, &msg, 1_000).unwrap();
        let plaintext = decrypt_from(&mac.secret_key, &id.pubkey_hex, &cmd.content).unwrap();
        match decode_phone_to_bridge(&plaintext).unwrap() {
            PhoneToBridge::UploadImage(protocol::commands::UploadImageMsg::Chunk(c)) => {
                assert_eq!(c.upload_id, "u-1");
                assert_eq!(c.chunk_index, 0);
                assert_eq!(c.total_chunks, 3);
            }
            other => panic!("expected chunk upload-image, got {other:?}"),
        }
    }

    #[test]
    fn build_command_rejects_cleartext_provider_base_url() {
        let (id, mac) = (phone(), machine());
        let msg = decode_phone_to_bridge(
            &json!({
                "type": "set-provider-profile",
                "profileId": "p",
                "profile": {
                    "label": "L",
                    "baseUrl": "http://api.example.com",
                    "authToken": "tok",
                    "models": [],
                },
            })
            .to_string(),
        )
        .unwrap();

        let err = build_command(&id, &mac.pubkey_hex, &msg, 1_000).unwrap_err();
        assert!(matches!(err, EgressError::Invalid(_)), "got {err:?}");
    }

    #[test]
    fn build_command_envelope_is_stable_for_a_fixed_clock() {
        // The NIP-44 nonce and schnorr aux-rand make `content`/`id`/`sig` vary
        // per call; the envelope the runtime routes on (created_at, kind, tags)
        // must not.
        let (id, mac) = (phone(), machine());
        let msg = decode_phone_to_bridge(r#"{"type":"refresh-sessions"}"#).unwrap();
        let a = build_command(&id, &mac.pubkey_hex, &msg, 5_000).unwrap();
        let b = build_command(&id, &mac.pubkey_hex, &msg, 5_000).unwrap();
        assert_eq!(a.created_at, b.created_at);
        assert_eq!(a.kind, b.kind);
        assert_eq!(a.tags, b.tags);
    }

    // --- publish verdict --------------------------------------------------

    #[test]
    fn classify_publish_decodes_each_relay_outcome() {
        assert_eq!(classify_publish(Ok("")).verdict, PublishVerdict::Accepted);
        assert_eq!(
            classify_publish(Ok("connection failure: ECONNREFUSED")).verdict,
            PublishVerdict::Unreachable
        );
        assert_eq!(
            classify_publish(Err("relay: publish timed out")).verdict,
            PublishVerdict::Unconfirmed
        );
        assert_eq!(
            classify_publish(Err("rate-limited: slow down")).verdict,
            PublishVerdict::Rejected
        );
        assert_eq!(
            classify_publish(Err("blocked: not on allowlist")).verdict,
            PublishVerdict::Rejected
        );
    }

    #[test]
    fn combine_publish_takes_the_softest_verdict() {
        let mk = |v| PublishResult { verdict: v, detail: None };
        assert_eq!(
            combine_publish(&[
                mk(PublishVerdict::Rejected),
                mk(PublishVerdict::Accepted),
                mk(PublishVerdict::Unreachable),
            ])
            .verdict,
            PublishVerdict::Accepted
        );
        assert_eq!(
            combine_publish(&[mk(PublishVerdict::Rejected), mk(PublishVerdict::Unreachable)])
                .verdict,
            PublishVerdict::Rejected
        );
        assert_eq!(combine_publish(&[]).verdict, PublishVerdict::Unreachable);
    }

    #[test]
    fn delivered_covers_accepted_and_unconfirmed_only() {
        assert!(PublishVerdict::Accepted.is_delivered());
        assert!(PublishVerdict::Unconfirmed.is_delivered());
        assert!(!PublishVerdict::Rejected.is_delivered());
        assert!(!PublishVerdict::Unreachable.is_delivered());
    }

    // --- inbound: known-machine + decrypt gates -------------------------

    #[test]
    fn ingest_drops_events_from_unknown_pubkeys() {
        let mut api = BridgeApi::new();
        let (id, mac) = (phone(), machine());
        let content = event_content(r#"{"type":"input-ack","sessionId":"s","inputId":"i"}"#, &mac, &id);
        let out = api.ingest(&incoming(&content, &mac.pubkey_hex), &id, false, 1);
        assert_eq!(out, Ingested::UnknownMachine);
        assert_eq!(api.diagnostics().decrypt_failures, 0);
        assert_eq!(api.diagnostics().decode_failures, 0);
        assert!(api.diagnostics().invalid.is_empty());
    }

    #[test]
    fn ingest_reports_decrypt_failure_without_throwing() {
        let mut api = BridgeApi::new();
        let (id, mac) = (phone(), machine());
        let out = deliver(&mut api, &id, &mac, "not a nip44 ciphertext !!!");
        assert_eq!(out, Ingested::DecryptFailed);
        assert_eq!(api.diagnostics().decrypt_failures, 1);
        assert_eq!(api.diagnostics().decode_failures, 0);
        assert_eq!(api.diagnostics().invalid.len(), 1);
        assert_eq!(api.diagnostics().invalid[0].stage, InvalidStage::Decrypt);
    }

    #[test]
    fn ingest_decodes_a_valid_message() {
        let mut api = BridgeApi::new();
        let (id, mac) = (phone(), machine());
        let src = json!({
            "type": "output",
            "sessionId": "s1",
            "seq": 1,
            "entry": { "entryType": "text", "content": "hi", "timestamp": "2026-08-05T00:00:00Z" },
        });
        let want = decode_bridge_to_phone(&src.to_string()).unwrap();
        let content = event_content(&encode_bridge_to_phone(&want), &mac, &id);
        match deliver(&mut api, &id, &mac, &content) {
            Ingested::Message(got) => assert_eq!(*got, want),
            other => panic!("expected Message, got {other:?}"),
        }
    }

    #[test]
    fn ingest_records_a_decode_failure_for_invalid_plaintext() {
        let mut api = BridgeApi::new();
        let (id, mac) = (phone(), machine());
        let content = event_content(r#"{"type":"output","sessionId":"s"}"#, &mac, &id); // no seq/entry
        assert_eq!(deliver(&mut api, &id, &mac, &content), Ingested::DecodeFailed);
        assert_eq!(api.diagnostics().decode_failures, 1);
        assert_eq!(api.diagnostics().decrypt_failures, 0);
    }

    // --- inbound: chunk reassembly (ported from bridgeApiChunk.test.ts) ---

    fn cid_factory() -> impl FnMut() -> String {
        let mut n = 0u32;
        move || {
            let s = format!("t-cid-{n}");
            n += 1;
            s
        }
    }

    #[test]
    fn small_message_still_dispatches_directly() {
        let mut api = BridgeApi::new();
        let (id, mac) = (phone(), machine());
        let (want, wire) = big_output_wire(2, 1);
        let content = event_content(&wire, &mac, &id);
        match deliver(&mut api, &id, &mac, &content) {
            Ingested::Message(got) => assert_eq!(*got, want),
            other => panic!("expected Message, got {other:?}"),
        }
    }

    #[test]
    fn in_order_fragments_reassemble_into_one_message() {
        let mut api = BridgeApi::new();
        let (id, mac) = (phone(), machine());
        let (want, wire) = big_output_wire(150_000, 100);
        let frames = frame_encoded_message(&wire, cid_factory());
        assert!(frames.len() > 1);

        let mut delivered = Vec::new();
        for f in &frames {
            let content = event_content(f, &mac, &id);
            if let Ingested::Message(m) = deliver(&mut api, &id, &mac, &content) {
                delivered.push(*m);
            }
        }
        assert_eq!(delivered, vec![want]);
    }

    #[test]
    fn out_of_order_plus_duplicate_fragments_reassemble_exactly_once() {
        let mut api = BridgeApi::new();
        let (id, mac) = (phone(), machine());
        let (want, wire) = big_output_wire(120_000, 205);
        let mut frames = frame_encoded_message(&wire, cid_factory());
        frames.reverse();

        let mut delivered = Vec::new();
        let feed = |api: &mut BridgeApi, frame: &str, out: &mut Vec<BridgeToPhone>| {
            let content = event_content(frame, &mac, &id);
            if let Ingested::Message(m) = deliver(api, &id, &mac, &content) {
                out.push(*m);
            }
        };
        feed(&mut api, &frames[0], &mut delivered);
        feed(&mut api, &frames[0], &mut delivered); // duplicate
        for f in &frames[1..] {
            feed(&mut api, f, &mut delivered);
        }
        assert_eq!(delivered, vec![want]);
    }

    #[test]
    fn a_missing_fragment_never_dispatches_and_is_not_a_decode_failure() {
        let mut api = BridgeApi::new();
        let (id, mac) = (phone(), machine());
        let (_, wire) = big_output_wire(150_000, 300);
        let frames = frame_encoded_message(&wire, cid_factory());
        let drop_at = frames.len() / 2;

        let mut delivered = 0;
        for (i, f) in frames.iter().enumerate() {
            if i == drop_at {
                continue;
            }
            let content = event_content(f, &mac, &id);
            if let Ingested::Message(_) = deliver(&mut api, &id, &mac, &content) {
                delivered += 1;
            }
        }
        assert_eq!(delivered, 0);
        assert_eq!(api.diagnostics().decode_failures, 0);
        assert_eq!(api.diagnostics().decrypt_failures, 0);
    }

    #[test]
    fn a_whole_message_interleaved_with_another_ones_fragments_is_not_blocked() {
        let mut api = BridgeApi::new();
        let (id, mac) = (phone(), machine());
        let (_, big_wire) = big_output_wire(150_000, 100);
        let frames = frame_encoded_message(&big_wire, cid_factory());

        let small = decode_bridge_to_phone(
            &json!({
                "type": "output",
                "sessionId": "s1",
                "seq": 101,
                "entry": { "entryType": "text", "content": "quick follow-up", "timestamp": "2026-08-05T00:00:00Z" },
            })
            .to_string(),
        )
        .unwrap();

        let mut seqs = Vec::new();
        let record = |api: &mut BridgeApi, payload: &str, seqs: &mut Vec<u64>| {
            let content = event_content(payload, &mac, &id);
            if let Ingested::Message(m) = deliver(api, &id, &mac, &content) {
                if let BridgeToPhone::Output(o) = *m {
                    seqs.push(o.seq);
                }
            }
        };
        record(&mut api, &frames[0], &mut seqs);
        record(&mut api, &encode_bridge_to_phone(&small), &mut seqs); // whole message, mid-stream
        for f in &frames[1..] {
            record(&mut api, f, &mut seqs);
        }
        seqs.sort_unstable();
        assert_eq!(seqs, vec![100, 101]);
    }

    #[test]
    fn an_invalid_chunk_envelope_is_recorded_and_dropped() {
        let mut api = BridgeApi::new();
        let (id, mac) = (phone(), machine());
        let bad = json!({ "type": "chunk", "cid": "x", "i": 9, "n": 3, "part": "p" }).to_string();
        let content = event_content(&bad, &mac, &id);
        assert_eq!(deliver(&mut api, &id, &mac, &content), Ingested::DecodeFailed);
        assert_eq!(api.diagnostics().decode_failures, 1);
    }

    // --- folder-ack correlation -----------------------------------------

    #[test]
    fn folder_request_ids_are_unique_and_tracked() {
        let mut api = BridgeApi::new();
        let a = api.next_folder_request_id(1_000);
        let b = api.next_folder_request_id(1_000);
        assert_ne!(a, b);
        assert_eq!(api.pending_folder_ack_count(), 2);
        assert!(api.take_pending_folder_ack(&a));
        assert!(!api.take_pending_folder_ack(&a)); // second take is a miss
        assert!(api.take_pending_folder_ack(&b));
        assert_eq!(api.pending_folder_ack_count(), 0);
    }

    #[test]
    fn generate_keypair_is_usable_as_an_identity() {
        // guards the test helpers above against a crypto regression
        let id = generate_keypair();
        let mac = generate_keypair();
        let msg = decode_phone_to_bridge(r#"{"type":"models-request"}"#).unwrap();
        let cmd = build_command(&id, &mac.pubkey_hex, &msg, 0).unwrap();
        assert_eq!(cmd.pubkey, id.pubkey_hex);
    }
}
