//! Marmot (MLS) DMs — CDX-012, plan §5b.
//!
//! MDK 0.8 (Marmot Development Kit, rust-nostr family — the same protocol
//! stack as White Noise and the local yenn reference) does ALL the MLS crypto
//! and group state in Rust, persisted in its own SQLCipher-encrypted SQLite
//! file in the app data dir. JS owns transport: every command returns Nostr
//! events as JSON for the webview to publish through the app's existing relay
//! client, and the webview feeds received relay events back in via
//! `marmot_ingest`.
//!
//! Wire model (MDK 0.8 / MIP-00, verified against the yenn reference):
//!   • KeyPackages are ADDRESSABLE kind-30443 events (not 443), signed by the
//!     real identity key, carrying a `d` tag.
//!   • Welcomes are kind-444 rumors that ONLY travel gift-wrapped inside
//!     kind-1059 wraps (a bare 444 on a relay leaks group membership); the
//!     accept path needs the WRAPPER event id, not the rumor id.
//!   • Group messages are kind-445 events signed by MLS-exporter-derived
//!     ephemeral keys, routed by the `h` tag (hex `nostr_group_id`).
//!
//! Hard-won reference behaviors ported verbatim (do NOT invent MLS handling):
//!   • VEIL-029 guard: NEVER hand a 445 for a not-yet-joined group to
//!     `process_message` — MDK permanently poisons the event ("Failed" →
//!     forever `Unprocessable`), and the creator's first message legitimately
//!     races ahead of the welcome. Return `not_joined`; the JS side buffers
//!     and re-feeds after the welcome is accepted.
//!   • VEIL-117: accept EXACTLY the welcome `process_welcome` returned (keyed
//!     by rumor id via `get_welcome`), never `get_pending_welcomes().first()`.
//!   • VEIL-167: re-feeding an already-processed 445 can't re-decrypt (MLS
//!     ratchet secrets are consumed) — serve the rumor MDK persisted on first
//!     processing instead of surfacing the failure (idempotent re-feed).
//!
//! Secrets discipline: the identity secret and the derived DB key are never
//! logged and never appear in error strings.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mdk_core::prelude::*;
use mdk_sqlite_storage::{EncryptionConfig, MdkSqliteStorage};
use nostr::nips::nip59::UnwrappedGift;
use nostr::prelude::*;
use serde::Serialize;
use sha2::{Digest, Sha256};

/// MDK 0.8 / MIP-00: key packages are addressable kind-30443 events.
pub const KIND_KEY_PACKAGE: u16 = 30443;

/// Marmot chat rumors are kind 9 (chat/control), mirroring White Noise/yenn.
pub const KIND_CHAT_RUMOR: u16 = 9;

const GROUP_NAME: &str = "CodeDeck DM";
const GROUP_DESCRIPTION: &str = "CodeDeck direct messages";

// --- Serializable results (the JS seam parses these with zod) ---

#[derive(Debug, Clone, Serialize)]
pub struct GroupInfo {
    /// MLS group id (hex) — the send/receive handle.
    pub group_id: String,
    /// Nostr group id (hex) — the kind-445 `h`-tag routing key.
    pub h_tag: String,
    pub name: String,
    /// Live member pubkeys (hex), including ourselves.
    pub members: Vec<String>,
    pub admins: Vec<String>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WelcomeInfo {
    /// Welcome RUMOR id (hex) — the accept key (VEIL-117).
    pub welcome_id: String,
    /// The kind-1059 wrapper event id (hex).
    pub wrapper_id: String,
    pub group_id: String,
    pub h_tag: String,
    pub name: String,
    /// Who invited us (hex pubkey) — the 1:1 peer.
    pub welcomer: String,
    pub member_count: u32,
}

#[derive(Debug, Serialize)]
pub struct GroupCreated {
    pub group_id: String,
    pub h_tag: String,
    /// The gift-wrapped (kind-1059) welcome event JSON to publish for the peer.
    pub welcome_event_json: String,
}

#[derive(Debug, Serialize)]
pub struct Outgoing {
    /// The kind-445 event JSON to publish.
    pub event_json: String,
    /// Inner rumor id (hex) — the stable message id the recipient will also
    /// see, used for the optimistic echo + structural dedup.
    pub rumor_id: String,
    /// Rumor created_at (unix seconds).
    pub created_at: u64,
}

/// One ingested relay event, dispatched by what it turned out to be.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Ingested {
    /// A Marmot welcome now pending locally — surface an invite card.
    Welcome {
        welcome_id: String,
        wrapper_id: String,
        group_id: String,
        h_tag: String,
        name: String,
        welcomer: String,
        member_count: u32,
    },
    /// A decrypted application message in a joined group.
    Message {
        group_id: String,
        id: String,
        sender: String,
        kind: u16,
        content: String,
        created_at: u64,
    },
    /// A 445 for a group we have not joined (yet) — JS buffers + re-feeds
    /// after the welcome is accepted (VEIL-029).
    NotJoined { h_tag: String },
    /// Processed fine but nothing to show (commit/proposal bookkeeping).
    None,
    /// Not for us / not decryptable / not a Marmot event — dropped, counted
    /// by the caller.
    Ignored { reason: String },
}

// --- The MDK wrapper (sync; the async gift-wrap lives at the command layer) ---

pub struct MarmotService {
    mdk: MDK<MdkSqliteStorage>,
    keys: Keys,
}

impl MarmotService {
    /// Open (or create) the MDK store at `db_path`. The SQLCipher key is
    /// derived (domain-separated SHA-256) from the identity secret: Android
    /// has no default keyring, so the host app owns key derivation — same
    /// decision as the yenn reference. Key/DB desync fails EAGERLY here.
    pub fn open(db_path: &Path, identity_secret_hex: &str) -> Result<Self, String> {
        // Deliberately generic errors: never echo secret material.
        let keys = Keys::parse(identity_secret_hex)
            .map_err(|_| "invalid identity secret".to_string())?;
        let mut hasher = Sha256::new();
        hasher.update(b"codedeck-marmot-db-v1");
        hasher.update(keys.secret_key().as_secret_bytes());
        let db_key: [u8; 32] = hasher.finalize().into();
        let storage = MdkSqliteStorage::new_with_key(db_path, EncryptionConfig::new(db_key))
            .map_err(|e| format!("open marmot storage: {e}"))?;
        Ok(Self {
            mdk: MDK::new(storage),
            keys,
        })
    }

    pub fn keys(&self) -> &Keys {
        &self.keys
    }

    pub fn pubkey_hex(&self) -> String {
        self.keys.public_key().to_hex()
    }

    /// Publish-ready kind-30443 KeyPackage event (signed) so peers can invite
    /// us. Each call mints a FRESH key package (MDK stores its private
    /// material); addressable semantics replace the previous one relay-side.
    pub fn key_package_event(&self, relays: &[String]) -> Result<Event, String> {
        let relay_urls = parse_relays(relays)?;
        let data = self
            .mdk
            .create_key_package_for_event(&self.keys.public_key(), relay_urls)
            .map_err(|e| format!("create key package: {e}"))?;
        EventBuilder::new(Kind::Custom(KIND_KEY_PACKAGE), data.content)
            .tags(data.tags_30443)
            .sign_with_keys(&self.keys)
            .map_err(|e| format!("sign key package: {e}"))
    }

    /// Create a 1:1 group, inviting `peer` via their fetched kind-30443 event.
    /// Returns the group + the kind-444 welcome RUMOR, which the (async)
    /// command layer MUST gift-wrap before publishing — never publish bare.
    pub fn create_group(
        &self,
        peer: &PublicKey,
        peer_kp_event: Event,
        relays: &[String],
    ) -> Result<(GroupInfo, UnsignedEvent), String> {
        let relay_urls = parse_relays(relays)?;
        let config = NostrGroupConfigData::new(
            GROUP_NAME.to_string(),
            GROUP_DESCRIPTION.to_string(),
            None,
            None,
            None,
            relay_urls,
            // Both members admin (yenn 1:1 pattern — either side can manage).
            vec![self.keys.public_key(), *peer],
        );
        let res = self
            .mdk
            .create_group(&self.keys.public_key(), vec![peer_kp_event], config)
            .map_err(|e| format!("create group: {e}"))?;
        let rumor = res
            .welcome_rumors
            .into_iter()
            .next()
            .ok_or_else(|| "create group returned no welcome rumor".to_string())?;
        let info = self.group_info_for(&res.group.mls_group_id)?;
        Ok((info, rumor))
    }

    /// Encrypt an outgoing chat message (kind-9 rumor → kind-445 event).
    pub fn send(&self, group_id_hex: &str, text: &str) -> Result<Outgoing, String> {
        let group_id = parse_group_id(group_id_hex)?;
        let rumor =
            EventBuilder::new(Kind::Custom(KIND_CHAT_RUMOR), text).build(self.keys.public_key());
        let rumor_id = rumor
            .id
            .ok_or_else(|| "outgoing rumor has no id".to_string())?
            .to_hex();
        let created_at = rumor.created_at.as_secs();
        let event = self
            .mdk
            .create_message(&group_id, rumor, None)
            .map_err(|e| format!("create message: {e}"))?;
        Ok(Outgoing {
            event_json: event.as_json(),
            rumor_id,
            created_at,
        })
    }

    /// Process a welcome rumor (already unwrapped from its 1059 by the command
    /// layer) into MDK's PENDING state — surfaced as an invite, accepted later.
    /// Idempotent per MDK.
    pub fn process_welcome(
        &self,
        wrapper_id: &EventId,
        rumor: &UnsignedEvent,
    ) -> Result<WelcomeInfo, String> {
        let welcome = self
            .mdk
            .process_welcome(wrapper_id, rumor)
            .map_err(|e| format!("process welcome: {e}"))?;
        Ok(welcome_info(&welcome))
    }

    pub fn pending_welcomes(&self) -> Result<Vec<WelcomeInfo>, String> {
        Ok(self
            .mdk
            .get_pending_welcomes(None)
            .map_err(|e| format!("get pending welcomes: {e}"))?
            .iter()
            .map(welcome_info)
            .collect())
    }

    /// Accept a pending welcome by its RUMOR id — exactly the welcome
    /// `process_welcome` returned (VEIL-117: never `.first()`). After this the
    /// group is joined; the caller re-feeds any buffered 445s.
    pub fn accept_welcome(&self, welcome_id_hex: &str) -> Result<GroupInfo, String> {
        let welcome_id = EventId::from_hex(welcome_id_hex)
            .map_err(|e| format!("parse welcome id: {e}"))?;
        let welcome = self
            .mdk
            .get_welcome(&welcome_id)
            .map_err(|e| format!("get welcome: {e}"))?
            .ok_or_else(|| {
                "pending welcome not found (expired or already consumed)".to_string()
            })?;
        let group_id = welcome.mls_group_id.clone();
        self.mdk
            .accept_welcome(&welcome)
            .map_err(|e| format!("accept welcome: {e}"))?;
        self.group_info_for(&group_id)
    }

    pub fn list_groups(&self) -> Result<Vec<GroupInfo>, String> {
        let groups = self
            .mdk
            .get_groups()
            .map_err(|e| format!("get groups: {e}"))?;
        groups
            .iter()
            .map(|g| self.stored_group_info(g))
            .collect()
    }

    /// Process an incoming kind-445. The VEIL-029 guard is mandatory: a 445
    /// for a group that is not JOINED locally must never reach
    /// `process_message` (see module docs).
    pub fn ingest_group_message(&self, event: &Event) -> Result<Ingested, String> {
        let Some(group) = self.joined_group(event)? else {
            return Ok(Ingested::NotJoined {
                h_tag: h_tag_of(event).unwrap_or_default(),
            });
        };
        let gid_hex = hex_bytes(group.mls_group_id.as_slice());
        match self.mdk.process_message(event) {
            Ok(MessageProcessingResult::ApplicationMessage(msg)) => {
                Ok(ingested_message(&msg, gid_hex))
            }
            // Already burned (a re-feed): serve the rumor MDK persisted when
            // it first decrypted this wrapper (VEIL-167 idempotency).
            Ok(MessageProcessingResult::Unprocessable { .. })
            | Ok(MessageProcessingResult::PreviouslyFailed) => {
                match self.cached_rumor(&group.mls_group_id, &event.id)? {
                    Some(msg) => Ok(msg),
                    None => Ok(Ingested::None),
                }
            }
            // Commits/proposals: `process_message` already merged what needed
            // merging for the 1:1 scope; nothing to show. (Multi-member leave
            // auto-commit publishing — yenn VEIL-309 — is out of Phase 6 UI
            // scope; the data model still converges on the admin's commits.)
            Ok(_) => Ok(Ingested::None),
            // First re-feed of an already-processed 445 surfaces as an error
            // (SecretReuseError). If a cached rumor exists this IS that case.
            Err(e) => match self.cached_rumor(&group.mls_group_id, &event.id)? {
                Some(msg) => Ok(msg),
                None => Err(format!("process message: {e}")),
            },
        }
    }

    /// The already-JOINED group a kind-445 belongs to, or None. Matches the
    /// `h` tag against ACTIVE groups only — `get_groups` also returns groups
    /// in `Pending` (created by `process_welcome` but never accepted), and
    /// handing their 445s to MDK would poison them (VEIL-117/029 class).
    fn joined_group(&self, event: &Event) -> Result<Option<group_types::Group>, String> {
        use group_types::GroupState;
        let Some(h) = h_tag_of(event) else {
            return Ok(None);
        };
        let groups = self
            .mdk
            .get_groups()
            .map_err(|e| format!("get groups: {e}"))?;
        Ok(groups
            .into_iter()
            .find(|g| g.state == GroupState::Active && hex_bytes(&g.nostr_group_id) == h))
    }

    /// VEIL-167 fallback: the decrypted rumor MDK persisted when it FIRST
    /// processed wrapper `wrapper_id` — paged scan on the public
    /// `wrapper_event_id` field (MDK keys `get_message` by the inner rumor id
    /// and the wrapper→rumor map has no public accessor).
    fn cached_rumor(
        &self,
        group: &GroupId,
        wrapper_id: &EventId,
    ) -> Result<Option<Ingested>, String> {
        use mdk_storage_traits::groups::Pagination;
        const PAGE: usize = 100;
        let mut offset = 0usize;
        loop {
            let page = self
                .mdk
                .get_messages(group, Some(Pagination::new(Some(PAGE), Some(offset))))
                .map_err(|e| format!("get messages: {e}"))?;
            let short_page = page.len() < PAGE;
            if let Some(msg) = page.into_iter().find(|m| m.wrapper_event_id == *wrapper_id) {
                return Ok(Some(ingested_message(&msg, hex_bytes(group.as_slice()))));
            }
            if short_page {
                return Ok(None);
            }
            offset += PAGE;
        }
    }

    fn group_info_for(&self, group_id: &GroupId) -> Result<GroupInfo, String> {
        let stored = self
            .mdk
            .get_groups()
            .map_err(|e| format!("get groups: {e}"))?
            .into_iter()
            .find(|g| &g.mls_group_id == group_id)
            .ok_or_else(|| "group not found".to_string())?;
        self.stored_group_info(&stored)
    }

    fn stored_group_info(&self, stored: &group_types::Group) -> Result<GroupInfo, String> {
        // Members are resolvable for joined groups only; a Pending group has
        // no MLS state yet — surface an empty roster instead of failing.
        let members = self
            .mdk
            .get_members(&stored.mls_group_id)
            .map(|set| set.into_iter().map(|p| p.to_hex()).collect())
            .unwrap_or_default();
        Ok(GroupInfo {
            group_id: hex_bytes(stored.mls_group_id.as_slice()),
            h_tag: hex_bytes(&stored.nostr_group_id),
            name: stored.name.clone(),
            members,
            admins: stored.admin_pubkeys.iter().map(|p| p.to_hex()).collect(),
            active: stored.state == group_types::GroupState::Active,
        })
    }
}

/// NIP-59 gift-wrap a kind-444 welcome rumor for `peer`. Marmot welcomes MUST
/// be wrapped before publish; the receiver's accept path needs the WRAPPER id.
pub async fn gift_wrap_welcome(
    keys: &Keys,
    peer: &PublicKey,
    welcome_rumor: UnsignedEvent,
) -> Result<Event, String> {
    if welcome_rumor.kind != Kind::MlsWelcome {
        return Err(format!(
            "expected a kind-444 welcome rumor, got kind {}",
            welcome_rumor.kind.as_u16()
        ));
    }
    EventBuilder::gift_wrap(keys, peer, welcome_rumor, [])
        .await
        .map_err(|e| format!("gift wrap welcome: {e}"))
}

/// Unwrap a kind-1059 addressed to us; `Ok` only for a Marmot welcome rumor.
pub async fn unwrap_welcome(
    keys: &Keys,
    gift_wrap: &Event,
) -> Result<(EventId, UnsignedEvent), String> {
    if gift_wrap.kind != Kind::GiftWrap {
        return Err(format!(
            "expected kind-1059, got kind {}",
            gift_wrap.kind.as_u16()
        ));
    }
    let unwrapped = UnwrappedGift::from_gift_wrap(keys, gift_wrap)
        .await
        .map_err(|e| format!("unwrap gift wrap: {e}"))?;
    if unwrapped.rumor.kind != Kind::MlsWelcome {
        return Err(format!(
            "gift wrap rumor kind {} is not a Marmot welcome",
            unwrapped.rumor.kind.as_u16()
        ));
    }
    Ok((gift_wrap.id, unwrapped.rumor))
}

// --- helpers ---

fn parse_relays(relays: &[String]) -> Result<Vec<RelayUrl>, String> {
    relays
        .iter()
        .map(|r| RelayUrl::parse(r).map_err(|e| format!("invalid relay url {r}: {e}")))
        .collect()
}

fn parse_group_id(hex_str: &str) -> Result<GroupId, String> {
    let bytes = hex::decode(hex_str).map_err(|e| format!("parse group id: {e}"))?;
    Ok(GroupId::from_slice(&bytes))
}

fn h_tag_of(event: &Event) -> Option<String> {
    event
        .tags
        .iter()
        .find(|t| t.kind() == TagKind::h())
        .and_then(|t| t.content())
        .map(|s| s.to_string())
}

fn welcome_info(w: &welcome_types::Welcome) -> WelcomeInfo {
    WelcomeInfo {
        welcome_id: w.id.to_hex(),
        wrapper_id: w.wrapper_event_id.to_hex(),
        group_id: hex_bytes(w.mls_group_id.as_slice()),
        h_tag: hex_bytes(&w.nostr_group_id),
        name: w.group_name.clone(),
        welcomer: w.welcomer.to_hex(),
        member_count: w.member_count,
    }
}

fn ingested_message(msg: &message_types::Message, group_id: String) -> Ingested {
    Ingested::Message {
        group_id,
        id: msg.id.to_hex(),
        sender: msg.pubkey.to_hex(),
        kind: msg.kind.as_u16(),
        content: msg.content.clone(),
        created_at: msg.created_at.as_secs(),
    }
}

fn hex_bytes(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

// --- Tauri command layer ---
//
// One service behind a std Mutex, initialized by `marmot_init`. The lock is
// NEVER held across an await: async steps (gift wrap / unwrap) clone the Keys
// out first, sync MDK work happens under short lock scopes.

#[derive(Default)]
pub struct MarmotState(Mutex<Option<MarmotService>>);

impl MarmotState {
    fn with<T>(
        &self,
        f: impl FnOnce(&MarmotService) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self.0.lock().map_err(|_| "marmot lock poisoned".to_string())?;
        let svc = guard
            .as_ref()
            .ok_or_else(|| "marmot not initialized".to_string())?;
        f(svc)
    }

    fn keys(&self) -> Result<Keys, String> {
        self.with(|svc| Ok(svc.keys().clone()))
    }
}

/// Initialize (idempotent): open the MDK store in the app data dir with a key
/// derived from the identity secret. Returns our pubkey hex. The secret is
/// never logged; re-init with the SAME identity is a no-op, a DIFFERENT
/// identity is refused (one store per app data dir).
#[tauri::command]
pub async fn marmot_init(
    app: tauri::AppHandle,
    state: tauri::State<'_, MarmotState>,
    secret_hex: String,
) -> Result<String, String> {
    use tauri::Manager;
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    let db_path = dir.join("marmot.db");

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "marmot lock poisoned".to_string())?;
    if let Some(existing) = guard.as_ref() {
        let requested = Keys::parse(&secret_hex)
            .map_err(|_| "invalid identity secret".to_string())?;
        if requested.public_key() != existing.keys().public_key() {
            return Err("marmot already initialized with a different identity".into());
        }
        return Ok(existing.pubkey_hex());
    }
    let svc = MarmotService::open(&db_path, &secret_hex)?;
    let pubkey = svc.pubkey_hex();
    *guard = Some(svc);
    Ok(pubkey)
}

/// A fresh signed kind-30443 KeyPackage event (JSON) for JS to publish.
#[tauri::command]
pub async fn marmot_publish_key_package(
    state: tauri::State<'_, MarmotState>,
    relays: Vec<String>,
) -> Result<String, String> {
    state.with(|svc| Ok(svc.key_package_event(&relays)?.as_json()))
}

/// Create a 1:1 group with `peer` from their kind-30443 event JSON. Returns
/// the group ids + the gift-wrapped welcome (kind-1059 JSON) to publish.
#[tauri::command]
pub async fn marmot_create_group(
    state: tauri::State<'_, MarmotState>,
    peer_pubkey: String,
    peer_key_package_json: String,
    relays: Vec<String>,
) -> Result<GroupCreated, String> {
    let peer = PublicKey::from_hex(&peer_pubkey).map_err(|e| format!("parse peer pubkey: {e}"))?;
    let kp_event = Event::from_json(&peer_key_package_json)
        .map_err(|e| format!("parse key package event: {e}"))?;
    let (info, rumor) = state.with(|svc| svc.create_group(&peer, kp_event, &relays))?;
    let keys = state.keys()?;
    let wrapped = gift_wrap_welcome(&keys, &peer, rumor).await?;
    Ok(GroupCreated {
        group_id: info.group_id,
        h_tag: info.h_tag,
        welcome_event_json: wrapped.as_json(),
    })
}

/// Encrypt a chat message for a group → kind-445 JSON to publish + rumor id.
#[tauri::command]
pub async fn marmot_send(
    state: tauri::State<'_, MarmotState>,
    group_id: String,
    text: String,
) -> Result<Outgoing, String> {
    state.with(|svc| svc.send(&group_id, &text))
}

/// Feed one received relay event (kind 1059 or 445) into MDK. Never throws on
/// foreign/undecryptable events — returns `ignored` so the JS side counts it.
#[tauri::command]
pub async fn marmot_ingest(
    state: tauri::State<'_, MarmotState>,
    event_json: String,
) -> Result<Ingested, String> {
    let event = Event::from_json(&event_json).map_err(|e| format!("parse event: {e}"))?;
    if event.kind == Kind::GiftWrap {
        let keys = state.keys()?;
        let (wrapper_id, rumor) = match unwrap_welcome(&keys, &event).await {
            Ok(pair) => pair,
            Err(reason) => return Ok(Ingested::Ignored { reason }),
        };
        return match state.with(|svc| svc.process_welcome(&wrapper_id, &rumor)) {
            Ok(info) => Ok(Ingested::Welcome {
                welcome_id: info.welcome_id,
                wrapper_id: info.wrapper_id,
                group_id: info.group_id,
                h_tag: info.h_tag,
                name: info.name,
                welcomer: info.welcomer,
                member_count: info.member_count,
            }),
            // A dead/duplicate/foreign welcome is a drop, not an app error.
            Err(reason) => Ok(Ingested::Ignored { reason }),
        };
    }
    if event.kind == Kind::MlsGroupMessage {
        return state.with(|svc| svc.ingest_group_message(&event));
    }
    Ok(Ingested::Ignored {
        reason: format!("kind {} is not a Marmot event", event.kind.as_u16()),
    })
}

#[tauri::command]
pub async fn marmot_pending_welcomes(
    state: tauri::State<'_, MarmotState>,
) -> Result<Vec<WelcomeInfo>, String> {
    state.with(|svc| svc.pending_welcomes())
}

#[tauri::command]
pub async fn marmot_accept_welcome(
    state: tauri::State<'_, MarmotState>,
    welcome_id: String,
) -> Result<GroupInfo, String> {
    state.with(|svc| svc.accept_welcome(&welcome_id))
}

#[tauri::command]
pub async fn marmot_list_groups(
    state: tauri::State<'_, MarmotState>,
) -> Result<Vec<GroupInfo>, String> {
    state.with(|svc| svc.list_groups())
}

// --- Tests: the plan's "loopback two-instance test" at the Rust layer ---

#[cfg(test)]
mod tests {
    use super::*;

    const RELAY: &str = "wss://relay.example.com";

    fn service(dir: &Path, name: &str) -> (MarmotService, Keys) {
        let keys = Keys::generate();
        let secret = keys.secret_key().to_secret_hex();
        let svc = MarmotService::open(&dir.join(format!("{name}.db")), &secret).unwrap();
        (svc, keys)
    }

    /// A publishes a KeyPackage → B creates the group + welcome → A ingests
    /// the wrapped welcome, accepts → B sends → A reads, and the reverse.
    #[tokio::test]
    async fn loopback_two_instance_chat() {
        let dir = tempfile::tempdir().unwrap();
        let (a, a_keys) = service(dir.path(), "a");
        let (b, _b_keys) = service(dir.path(), "b");
        let relays = vec![RELAY.to_string()];

        // A's published KeyPackage: a signed, addressable kind-30443 with a d tag.
        let kp_a = a.key_package_event(&relays).unwrap();
        assert_eq!(kp_a.kind.as_u16(), KIND_KEY_PACKAGE);
        assert!(kp_a.verify().is_ok());
        assert!(
            kp_a.tags.iter().any(|t| t.kind() == TagKind::d()),
            "30443 must carry a d tag (addressable)"
        );

        // B creates the 1:1 group and gift-wraps the welcome for A.
        let (group, rumor) = b
            .create_group(&a_keys.public_key(), kp_a, &relays)
            .unwrap();
        assert_eq!(group.members.len(), 2);
        let wrap = gift_wrap_welcome(b.keys(), &a_keys.public_key(), rumor)
            .await
            .unwrap();
        assert_eq!(wrap.kind, Kind::GiftWrap);

        // A unwraps + processes into pending, then accepts THAT welcome.
        let (wrapper_id, rumor) = unwrap_welcome(a.keys(), &wrap).await.unwrap();
        let info = a.process_welcome(&wrapper_id, &rumor).unwrap();
        assert_eq!(info.group_id, group.group_id);
        assert_eq!(info.welcomer, b.pubkey_hex());
        let pending = a.pending_welcomes().unwrap();
        assert!(pending.iter().any(|w| w.welcome_id == info.welcome_id));
        let joined = a.accept_welcome(&info.welcome_id).unwrap();
        assert!(joined.active);
        assert_eq!(joined.h_tag, group.h_tag);

        // B → A.
        let out = b.send(&group.group_id, "hello from B").unwrap();
        let event = Event::from_json(&out.event_json).unwrap();
        assert_eq!(event.kind, Kind::MlsGroupMessage);
        // 445s are signed by MLS-exporter-derived EPHEMERAL keys, never the
        // author's identity key — the relay policy depends on this fact.
        assert_ne!(event.pubkey, b.keys().public_key());
        match a.ingest_group_message(&event).unwrap() {
            Ingested::Message { content, sender, id, .. } => {
                assert_eq!(content, "hello from B");
                assert_eq!(sender, b.pubkey_hex());
                assert_eq!(id, out.rumor_id);
            }
            other => panic!("expected message, got {other:?}"),
        }

        // A → B.
        let out = a.send(&group.group_id, "hello back from A").unwrap();
        let event = Event::from_json(&out.event_json).unwrap();
        match b.ingest_group_message(&event).unwrap() {
            Ingested::Message { content, sender, .. } => {
                assert_eq!(content, "hello back from A");
                assert_eq!(sender, a.pubkey_hex());
            }
            other => panic!("expected message, got {other:?}"),
        }

        // Both sides list the joined group.
        assert_eq!(a.list_groups().unwrap().len(), 1);
        assert_eq!(b.list_groups().unwrap().len(), 1);
    }

    /// The creator's first message races ahead of the welcome (VEIL-029): a
    /// 445 for a not-yet-joined group returns `not_joined` WITHOUT touching
    /// MDK, and the SAME event decrypts fine when re-fed after accept.
    #[tokio::test]
    async fn first_message_before_welcome_buffers_then_decrypts() {
        let dir = tempfile::tempdir().unwrap();
        let (a, a_keys) = service(dir.path(), "a");
        let (b, _) = service(dir.path(), "b");
        let relays = vec![RELAY.to_string()];

        let kp_a = a.key_package_event(&relays).unwrap();
        let (group, rumor) = b
            .create_group(&a_keys.public_key(), kp_a, &relays)
            .unwrap();
        let first = b.send(&group.group_id, "raced ahead").unwrap();
        let first_event = Event::from_json(&first.event_json).unwrap();

        // Arrives BEFORE the welcome: must be not_joined, never poisoned.
        match a.ingest_group_message(&first_event).unwrap() {
            Ingested::NotJoined { h_tag } => assert_eq!(h_tag, group.h_tag),
            other => panic!("expected not_joined, got {other:?}"),
        }

        // Welcome lands, A accepts, the buffered event is re-fed and decrypts.
        let wrap = gift_wrap_welcome(b.keys(), &a_keys.public_key(), rumor)
            .await
            .unwrap();
        let (wrapper_id, welcome_rumor) = unwrap_welcome(a.keys(), &wrap).await.unwrap();
        let info = a.process_welcome(&wrapper_id, &welcome_rumor).unwrap();
        a.accept_welcome(&info.welcome_id).unwrap();
        match a.ingest_group_message(&first_event).unwrap() {
            Ingested::Message { content, .. } => assert_eq!(content, "raced ahead"),
            other => panic!("expected message, got {other:?}"),
        }
    }

    /// Re-feeding an already-processed 445 serves the cached rumor instead of
    /// burning on the consumed ratchet secret (VEIL-167 idempotency) — the JS
    /// side re-feeds on every reconnect catch-up.
    #[tokio::test]
    async fn refeed_processed_message_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let (a, a_keys) = service(dir.path(), "a");
        let (b, _) = service(dir.path(), "b");
        let relays = vec![RELAY.to_string()];

        let kp_a = a.key_package_event(&relays).unwrap();
        let (group, rumor) = b
            .create_group(&a_keys.public_key(), kp_a, &relays)
            .unwrap();
        let wrap = gift_wrap_welcome(b.keys(), &a_keys.public_key(), rumor)
            .await
            .unwrap();
        let (wrapper_id, welcome_rumor) = unwrap_welcome(a.keys(), &wrap).await.unwrap();
        let info = a.process_welcome(&wrapper_id, &welcome_rumor).unwrap();
        a.accept_welcome(&info.welcome_id).unwrap();

        let out = b.send(&group.group_id, "same event twice").unwrap();
        let event = Event::from_json(&out.event_json).unwrap();
        for round in 0..2 {
            match a.ingest_group_message(&event).unwrap() {
                Ingested::Message { content, id, .. } => {
                    assert_eq!(content, "same event twice", "round {round}");
                    assert_eq!(id, out.rumor_id, "round {round}");
                }
                other => panic!("round {round}: expected message, got {other:?}"),
            }
        }
    }

    /// Our own published 445 echoes back from the relay subscription; the
    /// sender must read it as its own rumor id (JS dedups structurally).
    #[tokio::test]
    async fn own_echo_maps_back_to_rumor_id() {
        let dir = tempfile::tempdir().unwrap();
        let (a, a_keys) = service(dir.path(), "a");
        let (b, _) = service(dir.path(), "b");
        let relays = vec![RELAY.to_string()];

        let kp_a = a.key_package_event(&relays).unwrap();
        let (group, _rumor) = b
            .create_group(&a_keys.public_key(), kp_a, &relays)
            .unwrap();
        let out = b.send(&group.group_id, "echo me").unwrap();
        let event = Event::from_json(&out.event_json).unwrap();
        match b.ingest_group_message(&event).unwrap() {
            Ingested::Message { id, content, sender, .. } => {
                assert_eq!(id, out.rumor_id);
                assert_eq!(content, "echo me");
                assert_eq!(sender, b.pubkey_hex());
            }
            other => panic!("expected message, got {other:?}"),
        }
    }

    /// Store opening: same secret re-opens; a different secret is refused
    /// eagerly (key/DB desync must fail at open, not corrupt later).
    #[test]
    fn store_key_desync_fails_eagerly() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::generate();
        let secret = keys.secret_key().to_secret_hex();
        let db = dir.path().join("store.db");
        drop(MarmotService::open(&db, &secret).unwrap());
        // Same key: fine.
        drop(MarmotService::open(&db, &secret).unwrap());
        // Different key: refused.
        let other = Keys::generate().secret_key().to_secret_hex();
        assert!(MarmotService::open(&db, &other).is_err());
    }
}
