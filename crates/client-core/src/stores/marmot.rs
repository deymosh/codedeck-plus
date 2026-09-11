//! `marmot` store — Marmot (MLS) group DMs (CDX-012, Phase 6). Port of the pure
//! half of `apps/mobile/src/core/stores/marmot.ts`.
//!
//! Split of labour (plan §5b): the MDK engine in Rust (`client-runtime`, its own
//! encrypted SQLite store) does ALL the MLS crypto + group state; this state
//! machine owns transport bookkeeping + presentation. Every outgoing event
//! comes back from the engine as JSON for the app relay client to publish;
//! every received relay event is fed into the engine and its `MarmotIngested`
//! result applied here.
//!
//! Wire model (MDK 0.8 / MIP-00, the yenn reference — NOT kind 443):
//! - KeyPackages: addressable kind-30443, identity-signed, on the app relays.
//! - Welcomes: kind-444 rumors gift-wrapped in kind-1059 — they arrive on the
//!   `dm` store's 1059 subscription, which routes non-NIP-17 rumors here.
//! - Group messages: kind-445, routed by the `h` tag (hex group id).
//! - kind-10051: KeyPackage relay list (MIP-00), beside the KP.
//!
//! VEIL-029: a 445 for a not-yet-joined group returns `not_joined` — those are
//! BUFFERED (the group creator's first message races the welcome) and re-fed
//! after the welcome is accepted.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::dm::{DmConversation, DmProtocol};

// --- Kinds + constants (standard Marmot, NOT packages/protocol) ---

pub const KEY_PACKAGE_KIND: u16 = 30443;
pub const WELCOME_RUMOR_KIND: i64 = 444;
pub const GROUP_MESSAGE_KIND: u16 = 445;
pub const KP_RELAY_LIST_KIND: u16 = 10051;

/// 445 `created_at` is honest (no NIP-59 randomization) — a modest catch-up
/// grace absorbs clock skew; structural dedup absorbs the replays.
pub const GROUP_MESSAGE_SINCE_GRACE_SECONDS: u64 = 60 * 60;

pub const MAX_MESSAGES_PER_CONVERSATION: usize = 500;
/// Bounded buffer for 445s that arrive before their group is joined.
pub const MAX_UNJOINED_BUFFER: usize = 300;

pub const MARMOT_STORAGE_KEY: &str = "marmot";
pub const KEY_PACKAGE_FETCH_TIMEOUT_MS: u64 = 8_000;

/// CDX-030: KeyPackage rotation threshold. MLS KPs are one-shot, so exactly one
/// unconsumed KP is kept on the relays and only re-minted when it is gone
/// (consumed by a welcome), the relay set changed, or it has aged out. 30 days
/// balances relay hygiene against key freshness.
pub const KEY_PACKAGE_ROTATION_MS: u64 = 30 * 24 * 60 * 60 * 1000;

// --- Engine seam value types (the runtime maps the Tauri command JSON) ---

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarmotGroupInfo {
    pub group_id: String,
    pub h_tag: String,
    pub name: String,
    pub members: Vec<String>,
    pub admins: Vec<String>,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MarmotWelcomeInfo {
    pub welcome_id: String,
    pub wrapper_id: String,
    pub group_id: String,
    pub h_tag: String,
    pub name: String,
    /// Who invited us — the 1:1 peer.
    pub welcomer: String,
    #[specta(type = specta_typescript::Number)]
    pub member_count: u64,
}

/// One decrypted group message the engine handed back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarmotMessageResult {
    pub group_id: String,
    pub id: String,
    pub sender: String,
    pub kind: i64,
    pub content: String,
    pub created_at: u64,
}

/// The engine's verdict for one fed event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarmotIngested {
    Welcome(MarmotWelcomeInfo),
    Message(MarmotMessageResult),
    NotJoined { h_tag: String },
    None,
    Ignored { reason: String },
}

// --- Store types ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MarmotConversation {
    /// MLS group id (hex) — the conversation key.
    pub group_id: String,
    /// kind-445 routing key (`h` tag).
    pub h_tag: String,
    /// The other member (1:1); `""` until known. Profile lookups reuse the `dm`
    /// store's per-pubkey cache.
    pub peer_pubkey: String,
    pub name: String,
    #[specta(type = specta_typescript::Number)]
    pub member_count: u64,
    #[specta(type = specta_typescript::Number)]
    pub last_message_at: u64,
    #[specta(type = specta_typescript::Number)]
    pub unread_count: u64,
    pub last_preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum MarmotMessageStatus {
    Sent,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MarmotMessage {
    /// Inner rumor id — identical on the sender echo and the recipient copy.
    pub id: String,
    pub group_id: String,
    pub sender_pubkey: String,
    pub content: String,
    #[specta(type = specta_typescript::Number)]
    pub at: u64,
    pub status: MarmotMessageStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MarmotDiagnostics {
    pub events_received: u64,
    /// Ingest results of type `Ignored` — counted + logged, never silent.
    pub ignored: u64,
    /// Seam call failures — counted + logged, never thrown at the caller.
    pub errors: u64,
}

/// CDX-030: identity of the last KP we successfully published — persisted so
/// app restarts do NOT re-mint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PublishedKeyPackage {
    pub id: String,
    pub d_tag: String,
    /// Serialized relay list it was published to — a changed set needs a fresh
    /// publish so new relays carry a KP.
    pub relays_payload: String,
    #[specta(type = specta_typescript::Number)]
    pub published_at: u64,
    /// A welcome arrived — some KP of ours was consumed; re-mint next start.
    pub consumed: bool,
}

// --- Pure helpers ---

/// The 445 subscription filter for our groups' `h` tags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupMessageFilter {
    pub kinds: Vec<u16>,
    pub h: Vec<String>,
    pub since: Option<u64>,
}

pub fn build_group_message_filter(h_tags: &[String], since: Option<u64>) -> GroupMessageFilter {
    GroupMessageFilter {
        kinds: vec![GROUP_MESSAGE_KIND],
        h: h_tags.to_vec(),
        since: since.filter(|s| *s > 0),
    }
}

/// One-shot peer KeyPackage lookup filter (addressable — newest wins).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPackageFilter {
    pub kinds: Vec<u16>,
    pub authors: Vec<String>,
}

pub fn build_key_package_filter(peer_pubkey: &str) -> KeyPackageFilter {
    KeyPackageFilter {
        kinds: vec![KEY_PACKAGE_KIND],
        authors: vec![peer_pubkey.to_string()],
    }
}

/// Catch-up cursor for the 445 subscription (newest known − grace).
pub fn marmot_since_cursor(messages: &BTreeMap<String, Vec<MarmotMessage>>) -> Option<u64> {
    let latest = messages
        .values()
        .flatten()
        .map(|m| m.at / 1000)
        .max()
        .unwrap_or(0);
    (latest > 0).then(|| latest.saturating_sub(GROUP_MESSAGE_SINCE_GRACE_SECONDS))
}

/// The peer of a 1:1 group = the first member that is not us.
pub fn peer_of_group(members: &[String], me: &str) -> String {
    members
        .iter()
        .find(|m| m.as_str() != me)
        .cloned()
        .unwrap_or_default()
}

/// Pure mint decision (CDX-030): mint+publish a new KeyPackage only when none
/// is stored, the stored one was consumed, the relay set changed, or rotation
/// is due.
pub fn should_mint_key_package(
    stored: Option<&PublishedKeyPackage>,
    relays_payload: &str,
    now_ms: u64,
    rotation_ms: u64,
) -> bool {
    match stored {
        None => true,
        Some(kp) => {
            kp.consumed
                || kp.relays_payload != relays_payload
                || now_ms.saturating_sub(kp.published_at) >= rotation_ms
        }
    }
}

/// The Phase 6 unified conversation list: both protocols, newest first. `key` is
/// what the UI routes on (peer pubkey for NIP-17, group id for Marmot).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnifiedConversation {
    pub protocol: DmProtocol,
    pub key: String,
    pub peer_pubkey: String,
    pub last_message_at: u64,
    pub unread_count: u64,
    pub last_preview: String,
    /// Marmot: the MLS group's own name (`""` when none). NIP-17 always `""`.
    pub title: String,
    /// 2 for NIP-17; the MLS roster for Marmot.
    pub member_count: u64,
}

pub fn unified_conversations(
    nip17: &BTreeMap<String, DmConversation>,
    marmot: &BTreeMap<String, MarmotConversation>,
) -> Vec<UnifiedConversation> {
    let mut list: Vec<UnifiedConversation> = nip17
        .values()
        .map(|c| UnifiedConversation {
            protocol: DmProtocol::Nip17,
            key: c.peer_pubkey.clone(),
            peer_pubkey: c.peer_pubkey.clone(),
            last_message_at: c.last_message_at,
            unread_count: c.unread_count,
            last_preview: c.last_preview.clone(),
            title: String::new(),
            member_count: 2,
        })
        .chain(marmot.values().map(|c| UnifiedConversation {
            protocol: DmProtocol::Marmot,
            key: c.group_id.clone(),
            peer_pubkey: c.peer_pubkey.clone(),
            last_message_at: c.last_message_at,
            unread_count: c.unread_count,
            last_preview: c.last_preview.clone(),
            title: c.name.clone(),
            member_count: c.member_count,
        }))
        .collect();
    list.sort_by_key(|c| std::cmp::Reverse(c.last_message_at));
    list
}

// --- Persistence ---

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MarmotPersisted {
    #[serde(default)]
    pub conversations: BTreeMap<String, MarmotConversation>,
    #[serde(default)]
    pub messages: BTreeMap<String, Vec<MarmotMessage>>,
    /// CDX-030: last successfully published KeyPackage (`None` before first).
    #[serde(default, rename = "keyPackage")]
    pub key_package: Option<PublishedKeyPackage>,
}

/// Defensive parse of the persisted KP record (absent / garbage → `None`).
fn hydrate_key_package(raw: &serde_json::Value) -> Option<PublishedKeyPackage> {
    let obj = raw.as_object()?;
    let id = obj.get("id")?.as_str()?;
    if id.is_empty() {
        return None;
    }
    let published_at = obj.get("publishedAt")?.as_u64()?;
    Some(PublishedKeyPackage {
        id: id.to_string(),
        d_tag: obj.get("dTag").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        relays_payload: obj
            .get("relaysPayload")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        published_at,
        consumed: obj.get("consumed").and_then(|v| v.as_bool()) == Some(true),
    })
}

pub fn hydrate_marmot(raw: Option<&str>) -> MarmotPersisted {
    let Some(raw) = raw else {
        return MarmotPersisted::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return MarmotPersisted::default();
    };
    let Some(obj) = value.as_object() else {
        return MarmotPersisted::default();
    };

    let mut out = MarmotPersisted::default();

    if let Some(convs) = obj.get("conversations").and_then(|v| v.as_object()) {
        for (group_id, raw_conv) in convs {
            let Ok(conv) = serde_json::from_value::<MarmotConversation>(raw_conv.clone()) else {
                continue;
            };
            if conv.group_id.is_empty() {
                continue;
            }
            out.conversations.insert(group_id.clone(), conv);
        }
    }
    if let Some(msgs) = obj.get("messages").and_then(|v| v.as_object()) {
        for (group_id, raw_list) in msgs {
            let Some(arr) = raw_list.as_array() else {
                continue;
            };
            out.messages.insert(
                group_id.clone(),
                arr.iter()
                    .filter_map(|m| serde_json::from_value::<MarmotMessage>(m.clone()).ok())
                    .collect(),
            );
        }
    }
    out.key_package = obj.get("keyPackage").and_then(hydrate_key_package);
    out
}

pub fn serialize_marmot(persisted: &MarmotPersisted) -> String {
    serde_json::to_string(persisted).expect("MarmotPersisted serializes")
}

// --- State ---

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddOutcome {
    Inserted { counts_unread: bool, is_incoming: bool },
    DedupById,
    /// An id-match on a `Failed` local send — the relay echo confirmed it.
    PromotedToSent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BufferedEvent {
    h_tag: String,
    event: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarmotState {
    /// The engine seam exists AND init succeeded.
    pub available: bool,
    pub conversations: BTreeMap<String, MarmotConversation>,
    /// `group_id` → messages ascending by `at`.
    pub messages: BTreeMap<String, Vec<MarmotMessage>>,
    pub pending_welcomes: BTreeMap<String, MarmotWelcomeInfo>,
    pub active_group: Option<String>,
    pub subscribed: bool,
    pub diagnostics: MarmotDiagnostics,
    pub published_key_package: Option<PublishedKeyPackage>,
    unjoined_buffer: Vec<BufferedEvent>,
    pub max_messages_per_conversation: usize,
    pub max_unjoined_buffer: usize,
}

impl Default for MarmotState {
    fn default() -> Self {
        Self {
            available: false,
            conversations: BTreeMap::new(),
            messages: BTreeMap::new(),
            pending_welcomes: BTreeMap::new(),
            active_group: None,
            subscribed: false,
            diagnostics: MarmotDiagnostics::default(),
            published_key_package: None,
            unjoined_buffer: Vec::new(),
            max_messages_per_conversation: MAX_MESSAGES_PER_CONVERSATION,
            max_unjoined_buffer: MAX_UNJOINED_BUFFER,
        }
    }
}

impl MarmotState {
    pub fn from_persisted(p: MarmotPersisted) -> Self {
        Self {
            conversations: p.conversations,
            messages: p.messages,
            published_key_package: p.key_package,
            ..Self::default()
        }
    }

    pub fn to_persisted(&self) -> MarmotPersisted {
        MarmotPersisted {
            conversations: self.conversations.clone(),
            messages: self.messages.clone(),
            key_package: self.published_key_package.clone(),
        }
    }

    pub fn since_cursor(&self) -> Option<u64> {
        marmot_since_cursor(&self.messages)
    }

    /// The `h` tags to subscribe 445s over.
    pub fn h_tags(&self) -> Vec<String> {
        self.conversations
            .values()
            .map(|c| c.h_tag.clone())
            .filter(|h| !h.is_empty())
            .collect()
    }

    /// Insert a message with structural (id-only) dedup and bump its
    /// conversation. An id-match on a `Failed` local send promotes it to `Sent`.
    pub fn add_message(&mut self, msg: MarmotMessage, me: &str) -> AddOutcome {
        let existing = self.messages.entry(msg.group_id.clone()).or_default();

        if let Some(m) = existing.iter_mut().find(|m| m.id == msg.id) {
            if m.status == MarmotMessageStatus::Failed {
                m.status = MarmotMessageStatus::Sent;
                return AddOutcome::PromotedToSent;
            }
            return AddOutcome::DedupById;
        }

        existing.push(msg.clone());
        existing.sort_by_key(|m| m.at);
        if existing.len() > self.max_messages_per_conversation {
            let drop = existing.len() - self.max_messages_per_conversation;
            existing.drain(0..drop);
        }
        let newest = existing.last().expect("just pushed").clone();

        let prev = self.conversations.get(&msg.group_id);
        let is_incoming = msg.sender_pubkey != me;
        let counts_unread =
            is_incoming && self.active_group.as_deref() != Some(msg.group_id.as_str());

        let conversation = MarmotConversation {
            group_id: msg.group_id.clone(),
            h_tag: prev.map_or(String::new(), |p| p.h_tag.clone()),
            peer_pubkey: prev.map(|p| p.peer_pubkey.clone()).unwrap_or_else(|| {
                if is_incoming {
                    msg.sender_pubkey.clone()
                } else {
                    String::new()
                }
            }),
            name: prev.map_or(String::new(), |p| p.name.clone()),
            member_count: prev.map_or(2, |p| p.member_count),
            last_message_at: newest.at,
            unread_count: prev.map_or(0, |p| p.unread_count) + u64::from(counts_unread),
            last_preview: newest.content,
        };
        self.conversations.insert(msg.group_id.clone(), conversation);

        AddOutcome::Inserted {
            counts_unread,
            is_incoming,
        }
    }

    /// A decrypted group message from the engine. Chat rumors are kind 9;
    /// reactions / deletes etc. are out of Phase 6 scope and dropped by kind.
    pub fn apply_group_message(&mut self, m: &MarmotMessageResult, me: &str) -> Option<AddOutcome> {
        if m.kind != 9 {
            return None;
        }
        let status = if m.sender == me {
            MarmotMessageStatus::Sent
        } else {
            MarmotMessageStatus::Delivered
        };
        Some(self.add_message(
            MarmotMessage {
                id: m.id.clone(),
                group_id: m.group_id.clone(),
                sender_pubkey: m.sender.clone(),
                content: m.content.clone(),
                at: m.created_at.saturating_mul(1000),
                status,
            },
            me,
        ))
    }

    /// Upsert a conversation from engine group info (join / create / reconcile).
    pub fn upsert_conversation(&mut self, info: &MarmotGroupInfo, me: &str, now: u64) {
        let prev = self.conversations.get(&info.group_id);
        let peer = {
            let p = peer_of_group(&info.members, me);
            if !p.is_empty() {
                p
            } else {
                prev.map_or(String::new(), |c| c.peer_pubkey.clone())
            }
        };
        let conversation = MarmotConversation {
            group_id: info.group_id.clone(),
            h_tag: info.h_tag.clone(),
            peer_pubkey: peer,
            name: info.name.clone(),
            member_count: if info.members.is_empty() {
                prev.map_or(2, |c| c.member_count)
            } else {
                info.members.len() as u64
            },
            last_message_at: prev.map_or(now, |c| c.last_message_at),
            unread_count: prev.map_or(0, |c| c.unread_count),
            last_preview: prev.map_or(String::new(), |c| c.last_preview.clone()),
        };
        self.conversations.insert(info.group_id.clone(), conversation);
    }

    /// A `welcome` ingest result: stage the pending card and, if we hold an
    /// unconsumed KP, mark it consumed (a peer used one of our one-shot KPs).
    /// Returns `true` when the stored KP changed (the runtime persists then).
    pub fn apply_welcome(&mut self, welcome: MarmotWelcomeInfo) -> bool {
        self.pending_welcomes
            .insert(welcome.welcome_id.clone(), welcome);
        match &mut self.published_key_package {
            Some(kp) if !kp.consumed => {
                kp.consumed = true;
                true
            }
            _ => false,
        }
    }

    /// A welcome was accepted engine-side: drop the pending card, upsert the
    /// group, backfill the peer from the welcomer if the roster has not settled.
    /// Returns the group's `h` tag so the runtime re-feeds buffered 445s.
    pub fn on_welcome_accepted(
        &mut self,
        welcome_id: &str,
        info: &MarmotGroupInfo,
        me: &str,
        now: u64,
    ) -> String {
        let welcome = self.pending_welcomes.remove(welcome_id);
        self.upsert_conversation(info, me, now);
        if let (Some(welcome), Some(conv)) = (welcome, self.conversations.get_mut(&info.group_id)) {
            if conv.peer_pubkey.is_empty() {
                conv.peer_pubkey = welcome.welcomer;
            }
        }
        info.h_tag.clone()
    }

    /// A welcome that can never be accepted (stale KP after reinstall, VEIL-117)
    /// — drop the card instead of an infinite retry.
    pub fn drop_pending_welcome(&mut self, welcome_id: &str) {
        self.pending_welcomes.remove(welcome_id);
    }

    pub fn store_published_key_package(&mut self, kp: PublishedKeyPackage) {
        self.published_key_package = Some(kp);
    }

    // --- VEIL-029 unjoined buffer ---

    /// Buffer a 445 whose group is not joined yet (bounded — oldest dropped).
    pub fn buffer_not_joined(&mut self, h_tag: &str, event: serde_json::Value) {
        if self.unjoined_buffer.len() >= self.max_unjoined_buffer {
            self.unjoined_buffer.remove(0);
        }
        self.unjoined_buffer.push(BufferedEvent {
            h_tag: h_tag.to_string(),
            event,
        });
    }

    /// Remove and return the buffered 445s for `h_tag`, order preserved — the
    /// runtime re-feeds them to the engine.
    pub fn take_buffered_for(&mut self, h_tag: &str) -> Vec<serde_json::Value> {
        let mut kept = Vec::with_capacity(self.unjoined_buffer.len());
        let mut taken = Vec::new();
        for buffered in std::mem::take(&mut self.unjoined_buffer) {
            if buffered.h_tag == h_tag {
                taken.push(buffered.event);
            } else {
                kept.push(buffered);
            }
        }
        self.unjoined_buffer = kept;
        taken
    }

    pub fn buffered_len(&self) -> usize {
        self.unjoined_buffer.len()
    }

    // --- read markers ---

    pub fn set_active_group(&mut self, group_id: Option<&str>) {
        self.active_group = group_id.map(str::to_string);
        if let Some(group_id) = group_id {
            self.mark_read(group_id);
        }
    }

    pub fn mark_read(&mut self, group_id: &str) -> bool {
        match self.conversations.get_mut(group_id) {
            Some(conv) if conv.unread_count != 0 => {
                conv.unread_count = 0;
                true
            }
            _ => false,
        }
    }

    // --- diagnostics ---

    pub fn note_event_received(&mut self) {
        self.diagnostics.events_received += 1;
    }

    pub fn note_ignored(&mut self) {
        self.diagnostics.ignored += 1;
    }

    pub fn note_error(&mut self) {
        self.diagnostics.errors += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ME: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const PEER: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn message(id: &str, group: &str, sender: &str, content: &str, at: u64) -> MarmotMessage {
        MarmotMessage {
            id: id.into(),
            group_id: group.into(),
            sender_pubkey: sender.into(),
            content: content.into(),
            at,
            status: MarmotMessageStatus::Delivered,
        }
    }

    fn group_info(group: &str, h: &str, members: &[&str]) -> MarmotGroupInfo {
        MarmotGroupInfo {
            group_id: group.into(),
            h_tag: h.into(),
            name: "".into(),
            members: members.iter().map(|m| m.to_string()).collect(),
            admins: vec![],
            active: true,
        }
    }

    fn welcome(id: &str, group: &str, h: &str, welcomer: &str) -> MarmotWelcomeInfo {
        MarmotWelcomeInfo {
            welcome_id: id.into(),
            wrapper_id: format!("wrap-{id}"),
            group_id: group.into(),
            h_tag: h.into(),
            name: "chat".into(),
            welcomer: welcomer.into(),
            member_count: 2,
        }
    }

    #[test]
    fn peer_of_group_picks_the_other_member() {
        assert_eq!(peer_of_group(&["me".into(), "them".into()], "me"), "them");
        assert_eq!(peer_of_group(&["me".into()], "me"), "");
    }

    #[test]
    fn marmot_since_cursor_is_newest_minus_grace() {
        assert_eq!(marmot_since_cursor(&BTreeMap::new()), None);
        let at = 1_700_000_000_000u64;
        let mut m = BTreeMap::new();
        m.insert("g1".into(), vec![message("a", "g1", "x", "x", at)]);
        assert_eq!(marmot_since_cursor(&m), Some(at / 1000 - 3600));
    }

    #[test]
    fn build_group_message_filter_routes_by_h_tags() {
        let f = build_group_message_filter(&["h1".into(), "h2".into()], Some(123));
        assert_eq!(f.kinds, vec![GROUP_MESSAGE_KIND]);
        assert_eq!(f.h, vec!["h1", "h2"]);
        assert_eq!(f.since, Some(123));
        assert_eq!(build_group_message_filter(&["h1".into()], Some(0)).since, None);
    }

    #[test]
    fn should_mint_key_package_none_consumed_relay_change_rotation() {
        let payload = r#"["wss://relay.example.com"]"#;
        let rotation = KEY_PACKAGE_ROTATION_MS;
        let fresh = PublishedKeyPackage {
            id: "e".repeat(64),
            d_tag: "kp".into(),
            relays_payload: payload.into(),
            published_at: 1_000,
            consumed: false,
        };
        assert!(should_mint_key_package(None, payload, 2_000, rotation));
        assert!(!should_mint_key_package(Some(&fresh), payload, 2_000, rotation));
        assert!(should_mint_key_package(
            Some(&PublishedKeyPackage { consumed: true, ..fresh.clone() }),
            payload,
            2_000,
            rotation
        ));
        assert!(should_mint_key_package(Some(&fresh), r#"["wss://other"]"#, 2_000, rotation));
        assert!(should_mint_key_package(Some(&fresh), payload, 1_000 + rotation, rotation));
        assert!(!should_mint_key_package(Some(&fresh), payload, 999 + rotation, rotation));
    }

    #[test]
    fn unified_conversations_merges_both_protocols_newest_first() {
        let mut nip17 = BTreeMap::new();
        nip17.insert(
            "p1".into(),
            DmConversation {
                peer_pubkey: "p1".into(),
                protocol: DmProtocol::Nip17,
                last_message_at: 100,
                unread_count: 1,
                last_preview: "old".into(),
            },
        );
        nip17.insert(
            "p2".into(),
            DmConversation {
                peer_pubkey: "p2".into(),
                protocol: DmProtocol::Nip17,
                last_message_at: 300,
                unread_count: 0,
                last_preview: "new".into(),
            },
        );
        let mut marmot = BTreeMap::new();
        marmot.insert(
            "g1".into(),
            MarmotConversation {
                group_id: "g1".into(),
                h_tag: "h1".into(),
                peer_pubkey: "p3".into(),
                name: "".into(),
                member_count: 2,
                last_message_at: 200,
                unread_count: 2,
                last_preview: "mls".into(),
            },
        );
        let merged = unified_conversations(&nip17, &marmot);
        assert_eq!(
            merged.iter().map(|c| c.key.clone()).collect::<Vec<_>>(),
            ["p2", "g1", "p1"]
        );
        assert_eq!(
            merged.iter().map(|c| c.protocol).collect::<Vec<_>>(),
            [DmProtocol::Nip17, DmProtocol::Marmot, DmProtocol::Nip17]
        );
        assert_eq!(merged[1].peer_pubkey, "p3");
        assert_eq!(merged[1].unread_count, 2);
    }

    #[test]
    fn add_message_dedups_by_id_and_promotes_a_failed_local_send() {
        let mut s = MarmotState::default();
        let mut mine = message("r1", "g1", ME, "hi", 1_000);
        mine.status = MarmotMessageStatus::Failed;
        assert!(matches!(
            s.add_message(mine, ME),
            AddOutcome::Inserted { is_incoming: false, counts_unread: false }
        ));

        // the relay echo of the same id → promote Failed → Sent
        assert_eq!(
            s.add_message(message("r1", "g1", ME, "hi", 1_000), ME),
            AddOutcome::PromotedToSent
        );
        assert_eq!(s.messages["g1"][0].status, MarmotMessageStatus::Sent);
        // a third copy is a plain dedup
        assert_eq!(
            s.add_message(message("r1", "g1", ME, "hi", 1_000), ME),
            AddOutcome::DedupById
        );
    }

    #[test]
    fn add_message_unread_gating_and_incoming_backfills_the_peer() {
        let mut s = MarmotState::default();
        let out = s.add_message(message("m1", "g1", PEER, "yo", 1_000), ME);
        assert!(matches!(out, AddOutcome::Inserted { is_incoming: true, counts_unread: true }));
        assert_eq!(s.conversations["g1"].unread_count, 1);
        assert_eq!(s.conversations["g1"].peer_pubkey, PEER); // backfilled from sender

        assert!(s.mark_read("g1"));
        assert_eq!(s.conversations["g1"].unread_count, 0);

        s.set_active_group(Some("g1"));
        s.add_message(message("m2", "g1", PEER, "again", 2_000), ME);
        assert_eq!(s.conversations["g1"].unread_count, 0); // open → not counted
    }

    #[test]
    fn upsert_conversation_prefers_a_known_peer_and_keeps_prior_activity() {
        let mut s = MarmotState::default();
        s.add_message(message("m1", "g1", PEER, "hey", 5_000), ME);
        // engine reconcile with an unsettled roster keeps the known peer + time
        s.upsert_conversation(&group_info("g1", "h1", &[]), ME, 9_999);
        let c = &s.conversations["g1"];
        assert_eq!(c.h_tag, "h1");
        assert_eq!(c.peer_pubkey, PEER);
        assert_eq!(c.last_message_at, 5_000);

        // a settled roster names the peer + member count
        s.upsert_conversation(&group_info("g1", "h1", &[ME, PEER]), ME, 9_999);
        assert_eq!(s.conversations["g1"].peer_pubkey, PEER);
        assert_eq!(s.conversations["g1"].member_count, 2);
    }

    #[test]
    fn apply_welcome_stages_the_card_and_marks_the_kp_consumed() {
        let mut s = MarmotState {
            published_key_package: Some(PublishedKeyPackage {
                id: "kp1".into(),
                d_tag: "d".into(),
                relays_payload: "[]".into(),
                published_at: 1,
                consumed: false,
            }),
            ..MarmotState::default()
        };
        assert!(s.apply_welcome(welcome("w1", "g1", "h1", PEER)));
        assert!(s.pending_welcomes.contains_key("w1"));
        assert!(s.published_key_package.as_ref().unwrap().consumed);
        // a second welcome does not re-flag (already consumed) → no persist hint
        assert!(!s.apply_welcome(welcome("w2", "g2", "h2", PEER)));
    }

    #[test]
    fn accepting_a_welcome_joins_the_group_backfills_the_peer_and_refeeds_buffer() {
        let mut s = MarmotState::default();
        s.apply_welcome(welcome("w1", "g1", "h1", PEER));

        // two 445s raced the welcome and got buffered
        s.buffer_not_joined("h1", json!({ "id": "e1" }));
        s.buffer_not_joined("h9", json!({ "id": "other" }));
        s.buffer_not_joined("h1", json!({ "id": "e2" }));
        assert_eq!(s.buffered_len(), 3);

        let h = s.on_welcome_accepted("w1", &group_info("g1", "h1", &[]), ME, 100);
        assert_eq!(h, "h1");
        assert!(!s.pending_welcomes.contains_key("w1"));
        assert_eq!(s.conversations["g1"].peer_pubkey, PEER); // from the welcomer

        let refed = s.take_buffered_for("h1");
        assert_eq!(refed, vec![json!({ "id": "e1" }), json!({ "id": "e2" })]);
        assert_eq!(s.buffered_len(), 1); // the unrelated h9 stays
    }

    #[test]
    fn buffer_not_joined_is_bounded() {
        let mut s = MarmotState {
            max_unjoined_buffer: 2,
            ..MarmotState::default()
        };
        s.buffer_not_joined("h", json!({ "n": 1 }));
        s.buffer_not_joined("h", json!({ "n": 2 }));
        s.buffer_not_joined("h", json!({ "n": 3 }));
        assert_eq!(
            s.take_buffered_for("h"),
            vec![json!({ "n": 2 }), json!({ "n": 3 })]
        );
    }

    #[test]
    fn apply_group_message_only_renders_kind_9() {
        let mut s = MarmotState::default();
        assert!(s
            .apply_group_message(
                &MarmotMessageResult {
                    group_id: "g1".into(),
                    id: "r1".into(),
                    sender: PEER.into(),
                    kind: 7, // a reaction — out of scope
                    content: "👍".into(),
                    created_at: 1_700_000_000,
                },
                ME
            )
            .is_none());
        assert!(s.messages.is_empty());

        let out = s.apply_group_message(
            &MarmotMessageResult {
                group_id: "g1".into(),
                id: "r2".into(),
                sender: PEER.into(),
                kind: 9,
                content: "hello".into(),
                created_at: 1_700_000_000,
            },
            ME,
        );
        assert!(matches!(out, Some(AddOutcome::Inserted { .. })));
        assert_eq!(s.messages["g1"][0].at, 1_700_000_000_000);
        assert_eq!(s.messages["g1"][0].status, MarmotMessageStatus::Delivered);
    }

    #[test]
    fn hydrate_marmot_tolerates_garbage_and_round_trips() {
        assert_eq!(hydrate_marmot(Some("{not json")), MarmotPersisted::default());
        assert_eq!(hydrate_marmot(None), MarmotPersisted::default());
        // garbage KP records hydrate to None, not a crash
        assert_eq!(
            hydrate_marmot(Some(r#"{"conversations":{},"messages":{},"keyPackage":{"id":42}}"#))
                .key_package,
            None
        );
        assert_eq!(
            hydrate_marmot(Some(r#"{"conversations":{},"messages":{},"keyPackage":"nope"}"#))
                .key_package,
            None
        );

        let mut s = MarmotState::default();
        s.add_message(message("m1", "g1", PEER, "persist me", 5_000), ME);
        s.store_published_key_package(PublishedKeyPackage {
            id: "e".repeat(64),
            d_tag: "kp".into(),
            relays_payload: "[]".into(),
            published_at: 1_700_000_000_000,
            consumed: false,
        });
        let raw = serialize_marmot(&s.to_persisted());
        let back = hydrate_marmot(Some(&raw));
        assert_eq!(back.conversations["g1"].last_preview, "persist me");
        assert_eq!(back.messages["g1"], s.messages["g1"]);
        assert_eq!(back.key_package.as_ref().unwrap().id, "e".repeat(64));

        let rebuilt = MarmotState::from_persisted(back);
        assert_eq!(rebuilt.conversations["g1"].unread_count, 1);
    }
}
