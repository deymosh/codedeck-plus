//! `dm` store — NIP-17 direct messages. Port of the pure half of
//! `apps/mobile/src/core/stores/dm.ts` (CDX-011 Phase 5b).
//!
//! DM content is standard Nostr (kind 14 rumor → kind 13 seal → kind 1059 gift
//! wrap) — deliberately protocol-independent, no `packages/protocol` schemas.
//! The gift-wrap crypto (`nip59` seal/wrap/unwrap), the transport subscription
//! with its epoch guard, the kind-10050 relay-list publish and the async
//! profile fetch all live in `client-runtime`; this module is the state
//! machine: structural dedup, conversation upsert, unread accounting, the
//! catch-up cursor math, and the persistence shape.
//!
//! Send path invariant: the kind-14 rumor is created ONCE (its id is the
//! message id across the recipient wrap, the self wrap and the optimistic local
//! add), so dedup is structural. The self-copy is what lets your own messages
//! survive a reinstall via relay catch-up.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use protocol::crypto::{hex_from_npub, npub_from_hex};

// --- Kinds + constants (standard Nostr, NOT packages/protocol) ---

pub const GIFT_WRAP_KIND: u16 = 1059;
pub const DM_RUMOR_KIND: i64 = 14;
pub const DM_RELAY_LIST_KIND: u16 = 10050;

/// NIP-59 randomizes gift-wrap `created_at` up to 2 days into the past — the
/// catch-up `since` must reach back at least that far.
pub const GIFT_WRAP_SINCE_GRACE_SECONDS: u64 = 2 * 24 * 60 * 60;

/// Bounded per-conversation history; fuzzy content dedup window for other NIP-17
/// clients that generate a different rumor id per wrap.
pub const MAX_MESSAGES_PER_CONVERSATION: usize = 500;
pub const CONTENT_DEDUP_WINDOW_S: u64 = 60;

pub const DM_STORAGE_KEY: &str = "dm";

// --- Types ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DmProtocol {
    Nip17,
    Marmot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DmConversation {
    pub peer_pubkey: String,
    pub protocol: DmProtocol,
    /// ms timestamp of the newest message (rumor time).
    #[specta(type = specta_typescript::Number)]
    pub last_message_at: u64,
    #[specta(type = specta_typescript::Number)]
    pub unread_count: u64,
    pub last_preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DmMessageStatus {
    Sent,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DmMessage {
    /// The rumor id — shared across the recipient wrap, the self wrap and the
    /// optimistic local add, so dedup is structural.
    pub id: String,
    pub peer_pubkey: String,
    pub sender_pubkey: String,
    pub content: String,
    /// ms timestamp (rumor `created_at` × 1000; local clock for failed sends).
    #[specta(type = specta_typescript::Number)]
    pub at: u64,
    pub status: DmMessageStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DmProfileState {
    Ok,
    Notfound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DmProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nip05: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    #[specta(type = specta_typescript::Number)]
    pub fetched_at: u64,
    pub status: DmProfileState,
}

/// Transient per-pubkey resolution status for the UI (not persisted).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DmProfileStatus {
    Loading,
    Ok,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DmDiagnostics {
    /// 1059 events seen by this store since app start.
    pub events_received: u64,
    /// Gift wraps we could not unwrap (CD-001: counted + logged, NEVER silent).
    pub unwrap_failures: u64,
    /// Unwrapped fine but not a valid kind-14 DM rumor.
    pub invalid_rumors: u64,
}

/// The unwrapped kind-14 rumor the runtime hands in (after `nip59` unwrap).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DmRumor {
    pub id: String,
    pub pubkey: String,
    pub kind: i64,
    pub content: String,
    pub created_at: u64,
    pub tags: Vec<Vec<String>>,
}

// --- Pure helpers ---

/// The catch-up cursor (seconds) for the 1059 subscription: newest known
/// message minus the 48 h gift-wrap randomization window. `None` = no local
/// history, fetch everything.
pub fn dm_since_cursor(messages: &BTreeMap<String, Vec<DmMessage>>) -> Option<u64> {
    let latest = messages
        .values()
        .flatten()
        .map(|m| m.at / 1000)
        .max()
        .unwrap_or(0);
    (latest > 0).then(|| latest.saturating_sub(GIFT_WRAP_SINCE_GRACE_SECONDS))
}

/// The one DM filter: gift wraps addressed to us, from the catch-up cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DmFilter {
    pub kinds: Vec<u16>,
    /// `#p` tag — the phone pubkey.
    pub p: String,
    pub since: Option<u64>,
}

pub fn build_dm_filter(pubkey_hex: &str, since: Option<u64>) -> DmFilter {
    DmFilter {
        kinds: vec![GIFT_WRAP_KIND],
        p: pubkey_hex.to_string(),
        since: since.filter(|s| *s > 0),
    }
}

/// `npub` bech32 or 64-char hex → hex pubkey; `None` on invalid (an `nsec`
/// falls through the hex check and is rejected).
pub fn parse_peer_input(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.starts_with("npub1") {
        return hex_from_npub(trimmed).ok();
    }
    if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(trimmed.to_ascii_lowercase());
    }
    None
}

/// Display label for a pubkey without a resolved profile.
pub fn truncate_peer_label(pubkey_hex: &str) -> String {
    if pubkey_hex.len() == 64 && pubkey_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        if let Ok(npub) = npub_from_hex(&pubkey_hex.to_ascii_lowercase()) {
            return format!("{}…{}", &npub[..10], &npub[npub.len() - 4..]);
        }
    }
    if pubkey_hex.len() < 16 {
        return pubkey_hex.to_string();
    }
    format!("{}…{}", &pubkey_hex[..8], &pubkey_hex[pubkey_hex.len() - 4..])
}

/// Conversation-list ordering: newest activity first.
pub fn ordered_conversations(
    conversations: &BTreeMap<String, DmConversation>,
) -> Vec<DmConversation> {
    let mut v: Vec<DmConversation> = conversations.values().cloned().collect();
    v.sort_by_key(|c| std::cmp::Reverse(c.last_message_at));
    v
}

// --- Persistence ---

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DmPersisted {
    #[serde(default)]
    pub conversations: BTreeMap<String, DmConversation>,
    #[serde(default)]
    pub messages: BTreeMap<String, Vec<DmMessage>>,
    #[serde(default)]
    pub profiles: BTreeMap<String, DmProfile>,
}

/// Garbage-tolerant hydrate — bad JSON / a non-object / a malformed entry each
/// drop to empty / skipped. Conversations force `protocol: nip17` and need a
/// non-empty `peerPubkey`; profiles need a numeric `fetchedAt`.
pub fn hydrate_dm(raw: Option<&str>) -> DmPersisted {
    let Some(raw) = raw else {
        return DmPersisted::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return DmPersisted::default();
    };
    let Some(obj) = value.as_object() else {
        return DmPersisted::default();
    };

    let mut out = DmPersisted::default();

    if let Some(convs) = obj.get("conversations").and_then(|v| v.as_object()) {
        for (peer, raw_conv) in convs {
            let Ok(mut conv) = serde_json::from_value::<DmConversation>(raw_conv.clone()) else {
                continue;
            };
            if conv.peer_pubkey.is_empty() {
                continue;
            }
            conv.protocol = DmProtocol::Nip17;
            out.conversations.insert(peer.clone(), conv);
        }
    }
    if let Some(msgs) = obj.get("messages").and_then(|v| v.as_object()) {
        for (peer, raw_list) in msgs {
            let Some(arr) = raw_list.as_array() else {
                continue;
            };
            let list: Vec<DmMessage> = arr
                .iter()
                .filter_map(|m| serde_json::from_value::<DmMessage>(m.clone()).ok())
                .collect();
            out.messages.insert(peer.clone(), list);
        }
    }
    if let Some(profiles) = obj.get("profiles").and_then(|v| v.as_object()) {
        for (peer, raw_profile) in profiles {
            if let Ok(profile) = serde_json::from_value::<DmProfile>(raw_profile.clone()) {
                out.profiles.insert(peer.clone(), profile);
            }
        }
    }
    out
}

pub fn serialize_dm(persisted: &DmPersisted) -> String {
    serde_json::to_string(persisted).expect("DmPersisted serializes")
}

// --- State ---

/// What `add_message` did — the runtime persists + fires `on_incoming` /
/// `resolve_profile` off an `Inserted`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddOutcome {
    Inserted {
        counts_unread: bool,
        /// The conversation did not exist before this message.
        new_conversation: bool,
        is_incoming: bool,
    },
    DedupById,
    DedupByContent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartConversation {
    pub peer: String,
    /// A new conversation row was created (runtime persists + resolves profile).
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DmState {
    pub conversations: BTreeMap<String, DmConversation>,
    /// `peer_pubkey` → messages ascending by `at`.
    pub messages: BTreeMap<String, Vec<DmMessage>>,
    /// Conversation open in the UI — incoming messages for it never count unread.
    pub active_peer: Option<String>,
    pub diagnostics: DmDiagnostics,
    pub profiles: BTreeMap<String, DmProfile>,
    pub profile_status: BTreeMap<String, DmProfileStatus>,
    pub max_messages_per_conversation: usize,
    pub content_dedup_window_ms: u64,
}

impl Default for DmState {
    fn default() -> Self {
        Self {
            conversations: BTreeMap::new(),
            messages: BTreeMap::new(),
            active_peer: None,
            diagnostics: DmDiagnostics::default(),
            profiles: BTreeMap::new(),
            profile_status: BTreeMap::new(),
            max_messages_per_conversation: MAX_MESSAGES_PER_CONVERSATION,
            content_dedup_window_ms: CONTENT_DEDUP_WINDOW_S * 1000,
        }
    }
}

impl DmState {
    pub fn from_persisted(p: DmPersisted) -> Self {
        Self {
            conversations: p.conversations,
            messages: p.messages,
            profiles: p.profiles,
            ..Self::default()
        }
    }

    pub fn to_persisted(&self) -> DmPersisted {
        DmPersisted {
            conversations: self.conversations.clone(),
            messages: self.messages.clone(),
            profiles: self.profiles.clone(),
        }
    }

    pub fn since_cursor(&self) -> Option<u64> {
        dm_since_cursor(&self.messages)
    }

    /// Insert a message with structural dedup and upsert its conversation.
    /// `me` is the phone pubkey (decides incoming vs own).
    pub fn add_message(&mut self, msg: DmMessage, me: &str) -> AddOutcome {
        let existing = self.messages.entry(msg.peer_pubkey.clone()).or_default();

        // Primary dedup: rumor id (covers the self-wrap echo of our own sends).
        if existing.iter().any(|m| m.id == msg.id) {
            return AddOutcome::DedupById;
        }
        // Fallback dedup: same sender + content within the window — other NIP-17
        // clients can generate a different rumor id per copy.
        let window = self.content_dedup_window_ms as i128;
        if existing.iter().any(|m| {
            m.sender_pubkey == msg.sender_pubkey
                && m.content == msg.content
                && (m.at as i128 - msg.at as i128).abs() < window
        }) {
            return AddOutcome::DedupByContent;
        }

        existing.push(msg.clone());
        existing.sort_by_key(|m| m.at);
        if existing.len() > self.max_messages_per_conversation {
            let drop = existing.len() - self.max_messages_per_conversation;
            existing.drain(0..drop);
        }
        let newest = existing.last().expect("just pushed").clone();

        let prev = self.conversations.get(&msg.peer_pubkey);
        let new_conversation = prev.is_none();
        let is_incoming = msg.sender_pubkey != me;
        let counts_unread = is_incoming && self.active_peer.as_deref() != Some(msg.peer_pubkey.as_str());

        let conversation = DmConversation {
            peer_pubkey: msg.peer_pubkey.clone(),
            protocol: DmProtocol::Nip17,
            last_message_at: newest.at,
            unread_count: prev.map_or(0, |p| p.unread_count) + u64::from(counts_unread),
            last_preview: newest.content,
        };
        self.conversations.insert(msg.peer_pubkey.clone(), conversation);

        AddOutcome::Inserted {
            counts_unread,
            new_conversation,
            is_incoming,
        }
    }

    /// Ingest an unwrapped kind-14 rumor (the runtime already did the `nip59`
    /// unwrap and confirmed `rumor.kind == DM_RUMOR_KIND`). Self-copies address
    /// the peer via the `p` tag, not the sender.
    pub fn ingest_dm_rumor(&mut self, rumor: &DmRumor, me: &str) -> AddOutcome {
        let sender = rumor.pubkey.to_ascii_lowercase();
        let p_tag = rumor
            .tags
            .iter()
            .find(|t| t.len() >= 2 && t[0] == "p" && !t[1].is_empty())
            .map(|t| t[1].clone());
        let peer_pubkey = if sender == me {
            p_tag.unwrap_or_else(|| sender.clone())
        } else {
            sender.clone()
        };
        let status = if sender == me {
            DmMessageStatus::Sent
        } else {
            DmMessageStatus::Delivered
        };
        self.add_message(
            DmMessage {
                id: rumor.id.clone(),
                peer_pubkey,
                sender_pubkey: sender,
                content: rumor.content.clone(),
                at: rumor.created_at.saturating_mul(1000),
                status,
            },
            me,
        )
    }

    pub fn note_event_received(&mut self) {
        self.diagnostics.events_received += 1;
    }

    pub fn note_unwrap_failure(&mut self) {
        self.diagnostics.unwrap_failures += 1;
    }

    pub fn note_invalid_rumor(&mut self) {
        self.diagnostics.invalid_rumors += 1;
    }

    /// Open (or create) a conversation for `peer_input` (npub / hex) and make it
    /// active. `None` on invalid input.
    pub fn start_conversation(&mut self, peer_input: &str, now: u64) -> Option<StartConversation> {
        let peer = parse_peer_input(peer_input)?;
        let created = !self.conversations.contains_key(&peer);
        if created {
            self.conversations.insert(
                peer.clone(),
                DmConversation {
                    peer_pubkey: peer.clone(),
                    protocol: DmProtocol::Nip17,
                    last_message_at: now,
                    unread_count: 0,
                    last_preview: String::new(),
                },
            );
        }
        self.set_active_peer(Some(&peer));
        Some(StartConversation { peer, created })
    }

    /// Set the open conversation; opening one also marks it read.
    pub fn set_active_peer(&mut self, peer: Option<&str>) {
        self.active_peer = peer.map(str::to_string);
        if let Some(peer) = peer {
            self.mark_read(peer);
        }
    }

    /// Clear a conversation's unread count. Returns `true` if it changed (the
    /// runtime persists then).
    pub fn mark_read(&mut self, peer: &str) -> bool {
        match self.conversations.get_mut(peer) {
            Some(conv) if conv.unread_count != 0 => {
                conv.unread_count = 0;
                true
            }
            _ => false,
        }
    }

    // --- Profile cache ---

    /// `true` when a `kind-0` fetch is worth doing: forced, or no cached `ok`
    /// profile, or the cached one is older than the TTL.
    pub fn profile_fetch_needed(&self, pubkey: &str, force: bool, now: u64, ttl_ms: u64) -> bool {
        if force {
            return true;
        }
        match self.profiles.get(pubkey) {
            Some(p) if p.status == DmProfileState::Ok => now.saturating_sub(p.fetched_at) >= ttl_ms,
            _ => true,
        }
    }

    pub fn set_profile_loading(&mut self, pubkey: &str) {
        self.profile_status
            .insert(pubkey.to_string(), DmProfileStatus::Loading);
    }

    /// Store a resolved profile. `notfound` is cached (cheap later retry) but
    /// surfaces as `Error` so the UI shows a tap-to-retry.
    pub fn apply_profile(&mut self, pubkey: &str, profile: DmProfile) {
        let status = match profile.status {
            DmProfileState::Ok => DmProfileStatus::Ok,
            DmProfileState::Notfound => DmProfileStatus::Error,
        };
        self.profiles.insert(pubkey.to_string(), profile);
        self.profile_status.insert(pubkey.to_string(), status);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const PEER: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn msg(id: &str, peer: &str, sender: &str, content: &str, at: u64) -> DmMessage {
        DmMessage {
            id: id.to_string(),
            peer_pubkey: peer.to_string(),
            sender_pubkey: sender.to_string(),
            content: content.to_string(),
            at,
            status: DmMessageStatus::Delivered,
        }
    }

    #[test]
    fn dm_since_cursor_math() {
        assert_eq!(dm_since_cursor(&BTreeMap::new()), None);
        let mut m = BTreeMap::new();
        m.insert("peer".to_string(), Vec::<DmMessage>::new());
        assert_eq!(dm_since_cursor(&m), None);

        let at_ms = 1_700_000_000_000u64;
        let mut m = BTreeMap::new();
        m.insert("a".to_string(), vec![msg("1", PEER, PEER, "x", at_ms - 60_000)]);
        m.insert(
            "b".to_string(),
            vec![
                msg("2", PEER, PEER, "y", at_ms),
                msg("3", PEER, PEER, "z", at_ms - 999_000),
            ],
        );
        assert_eq!(
            dm_since_cursor(&m),
            Some(at_ms / 1000 - GIFT_WRAP_SINCE_GRACE_SECONDS)
        );
        assert_eq!(GIFT_WRAP_SINCE_GRACE_SECONDS, 172_800);
    }

    #[test]
    fn build_dm_filter_adds_since_only_when_a_cursor_exists() {
        let p = "ab".repeat(32);
        assert_eq!(
            build_dm_filter(&p, None),
            DmFilter { kinds: vec![GIFT_WRAP_KIND], p: p.clone(), since: None }
        );
        assert_eq!(build_dm_filter(&p, Some(12345)).since, Some(12345));
        assert_eq!(build_dm_filter(&p, Some(0)).since, None);
    }

    #[test]
    fn parse_peer_input_accepts_npub_and_hex_rejects_garbage() {
        let kp = protocol::crypto::generate_keypair();
        assert_eq!(parse_peer_input(&kp.npub).as_deref(), Some(kp.pubkey_hex.as_str()));
        assert_eq!(
            parse_peer_input(&format!("  {}  ", kp.pubkey_hex.to_uppercase())).as_deref(),
            Some(kp.pubkey_hex.as_str())
        );
        assert_eq!(parse_peer_input("npub1notvalid"), None);
        assert_eq!(parse_peer_input("deadbeef"), None);
        // an nsec is not an npub — falls through the hex check, rejected
        let nsec = format!("nsec1{}", "q".repeat(58));
        assert_eq!(parse_peer_input(&nsec), None);
    }

    #[test]
    fn truncate_peer_label_prefers_an_npub_form() {
        let kp = protocol::crypto::generate_keypair();
        let label = truncate_peer_label(&kp.pubkey_hex);
        assert!(label.starts_with("npub1"));
        assert!(label.contains('…'));
        // non-hex short input passes through
        assert_eq!(truncate_peer_label("short"), "short");
    }

    #[test]
    fn ordered_conversations_newest_first() {
        let conv = |peer: &str, at: u64| DmConversation {
            peer_pubkey: peer.to_string(),
            protocol: DmProtocol::Nip17,
            last_message_at: at,
            unread_count: 0,
            last_preview: String::new(),
        };
        let mut m = BTreeMap::new();
        m.insert("a".to_string(), conv("a", 100));
        m.insert("b".to_string(), conv("b", 300));
        m.insert("c".to_string(), conv("c", 200));
        assert_eq!(
            ordered_conversations(&m).iter().map(|c| c.peer_pubkey.clone()).collect::<Vec<_>>(),
            ["b", "c", "a"]
        );
    }

    #[test]
    fn add_message_dedups_by_id_then_by_content_window() {
        let mut s = DmState::default();
        let first = s.add_message(msg("r1", PEER, PEER, "once only", 1_000_000), ME);
        assert!(matches!(first, AddOutcome::Inserted { is_incoming: true, new_conversation: true, counts_unread: true }));

        // same id → dedup
        assert_eq!(s.add_message(msg("r1", PEER, PEER, "once only", 1_000_000), ME), AddOutcome::DedupById);
        // different id, same sender+content within 60s → content dedup
        assert_eq!(
            s.add_message(msg("r2", PEER, PEER, "once only", 1_000_000 + 59_000), ME),
            AddOutcome::DedupByContent
        );
        // same content but outside the window → inserted
        assert!(matches!(
            s.add_message(msg("r3", PEER, PEER, "once only", 1_000_000 + 61_000), ME),
            AddOutcome::Inserted { .. }
        ));
        assert_eq!(s.messages[PEER].len(), 2);
    }

    #[test]
    fn add_message_sorts_by_at_and_caps_the_conversation() {
        let mut s = DmState {
            max_messages_per_conversation: 3,
            ..DmState::default()
        };
        s.add_message(msg("a", PEER, PEER, "at-300", 300), ME);
        s.add_message(msg("b", PEER, PEER, "at-100", 100), ME);
        s.add_message(msg("c", PEER, PEER, "at-200", 200), ME);
        s.add_message(msg("d", PEER, PEER, "at-400", 400), ME);
        // sorted by `at`: [b(100), c(200), a(300), d(400)]; the oldest is dropped
        let ids: Vec<_> = s.messages[PEER].iter().map(|m| m.id.clone()).collect();
        assert_eq!(ids, ["c", "a", "d"]);
    }

    #[test]
    fn unread_counts_only_while_the_conversation_is_not_active() {
        let mut s = DmState::default();
        s.add_message(msg("m1", PEER, PEER, "one", 1_000), ME);
        assert_eq!(s.conversations[PEER].unread_count, 1);

        assert!(s.mark_read(PEER));
        assert_eq!(s.conversations[PEER].unread_count, 0);
        assert!(!s.mark_read(PEER)); // already zero → no change

        // conversation open → incoming stays read
        s.set_active_peer(Some(PEER));
        s.add_message(msg("m2", PEER, PEER, "two", 2_000), ME);
        assert_eq!(s.conversations[PEER].unread_count, 0);

        // closed again → counts, and set_active_peer(peer) marks read
        s.set_active_peer(None);
        s.add_message(msg("m3", PEER, PEER, "three", 3_000), ME);
        assert_eq!(s.conversations[PEER].unread_count, 1);
        s.set_active_peer(Some(PEER));
        assert_eq!(s.conversations[PEER].unread_count, 0);
    }

    #[test]
    fn own_messages_never_count_unread() {
        let mut s = DmState::default();
        let out = s.add_message(msg("mine", PEER, ME, "hi", 1_000), ME);
        assert!(matches!(out, AddOutcome::Inserted { is_incoming: false, counts_unread: false, .. }));
        assert_eq!(s.conversations[PEER].unread_count, 0);
    }

    #[test]
    fn ingest_dm_rumor_routes_self_copies_by_p_tag() {
        let mut s = DmState::default();
        // incoming: sender is the peer
        let incoming = DmRumor {
            id: "in1".into(),
            pubkey: PEER.into(),
            kind: DM_RUMOR_KIND,
            content: "hi B".into(),
            created_at: 1_700_000_000,
            tags: vec![vec!["p".into(), ME.into()]],
        };
        assert!(matches!(s.ingest_dm_rumor(&incoming, ME), AddOutcome::Inserted { .. }));
        assert_eq!(s.messages[PEER][0].status, DmMessageStatus::Delivered);
        assert_eq!(s.messages[PEER][0].at, 1_700_000_000_000);

        // self-copy: sender == me, peer comes from the p tag
        let mut s = DmState::default();
        let self_copy = DmRumor {
            id: "self1".into(),
            pubkey: ME.into(),
            kind: DM_RUMOR_KIND,
            content: "from my old phone".into(),
            created_at: 1_700_000_000,
            tags: vec![vec!["p".into(), PEER.into()]],
        };
        s.ingest_dm_rumor(&self_copy, ME);
        assert_eq!(s.messages[PEER][0].sender_pubkey, ME);
        assert_eq!(s.messages[PEER][0].status, DmMessageStatus::Sent);
        assert_eq!(s.conversations[PEER].unread_count, 0);
    }

    #[test]
    fn diagnostics_counters() {
        let mut s = DmState::default();
        s.note_event_received();
        s.note_event_received();
        s.note_unwrap_failure();
        s.note_invalid_rumor();
        assert_eq!(
            s.diagnostics,
            DmDiagnostics { events_received: 2, unwrap_failures: 1, invalid_rumors: 1 }
        );
    }

    #[test]
    fn start_conversation_creates_once_activates_and_rejects_invalid() {
        let kp = protocol::crypto::generate_keypair();
        let mut s = DmState::default();

        assert_eq!(s.start_conversation("garbage", 10), None);
        assert!(s.conversations.is_empty());

        let out = s.start_conversation(&kp.npub, 10).unwrap();
        assert_eq!(out.peer, kp.pubkey_hex);
        assert!(out.created);
        assert_eq!(s.active_peer.as_deref(), Some(kp.pubkey_hex.as_str()));

        // hex form of the same peer → reused, not created
        let out2 = s.start_conversation(&kp.pubkey_hex, 20).unwrap();
        assert!(!out2.created);
        assert_eq!(s.conversations.len(), 1);
    }

    #[test]
    fn profile_cache_ttl_and_notfound_surfaces_as_error() {
        let mut s = DmState::default();
        let ttl = 24 * 60 * 60 * 1000;
        assert!(s.profile_fetch_needed(PEER, false, 0, ttl)); // nothing cached

        s.apply_profile(
            PEER,
            DmProfile {
                name: Some("Bee".into()),
                display_name: None,
                picture: None,
                nip05: None,
                about: None,
                fetched_at: 1_000,
                status: DmProfileState::Ok,
            },
        );
        assert_eq!(s.profile_status[PEER], DmProfileStatus::Ok);
        assert!(!s.profile_fetch_needed(PEER, false, 1_000 + ttl - 1, ttl)); // fresh
        assert!(s.profile_fetch_needed(PEER, false, 1_000 + ttl, ttl)); // stale
        assert!(s.profile_fetch_needed(PEER, true, 1_000, ttl)); // forced

        s.apply_profile(
            PEER,
            DmProfile {
                name: None,
                display_name: None,
                picture: None,
                nip05: None,
                about: None,
                fetched_at: 2_000,
                status: DmProfileState::Notfound,
            },
        );
        assert_eq!(s.profile_status[PEER], DmProfileStatus::Error);
    }

    #[test]
    fn persistence_round_trip_and_corrupt_hydrates_empty() {
        assert_eq!(hydrate_dm(Some("{not json")), DmPersisted::default());
        assert_eq!(hydrate_dm(None), DmPersisted::default());

        let mut s = DmState::default();
        s.add_message(msg("m1", PEER, PEER, "persist me", 5_000), ME);
        let raw = serialize_dm(&s.to_persisted());
        let back = hydrate_dm(Some(&raw));
        assert_eq!(back.conversations[PEER].last_preview, "persist me");
        assert_eq!(back.conversations[PEER].unread_count, 1);
        assert_eq!(back.messages[PEER], s.messages[PEER]);

        // a rebuilt state carries the unread count forward
        let rebuilt = DmState::from_persisted(back);
        assert_eq!(rebuilt.conversations[PEER].unread_count, 1);
    }
}
