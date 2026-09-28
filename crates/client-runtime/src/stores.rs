//! `CoreStores` — the bundle of `client_core` state machines the runtime owns,
//! with KV hydrate on boot and re-serialize after a mutation.
//!
//! The pure stores never touch the [`Kv`] / [`TranscriptStore`] ports; this
//! module reads them on boot to seed each store and writes a store back after
//! the runtime applies a mutation to it. Storage keys match the legacy
//! `apps/mobile/src/core` layout so an in-place upgrade keeps its data.

use client_core::delete_controller::DeleteController;
use client_core::notifications::{NotificationContext, NotificationCoordinator};
use client_core::stores::machines::{
    hydrate_dismissed, hydrate_machines, serialize_dismissed, serialize_machines, MachinesState,
    MergeOptions,
};
use client_core::stores::outbox::{hydrate_outbox, serialize_outbox, OutboxState};
use client_core::stores::pairing::PairingState;
use client_core::stores::pending_sessions::PendingSessionsState;
use client_core::stores::quick_prompts::{
    hydrate_quick_prompts, serialize_quick_prompts, QuickPromptsState, QUICK_PROMPTS_STORAGE_KEY,
};
use client_core::stores::settings::{hydrate_settings, serialize_settings, SettingsState};
use client_core::stores::transcript::TranscriptState;
use client_core::stores::ui::UiState;

use crate::ports::{Kv, TranscriptStore};

/// KV keys (kept identical to the TS `apps/mobile/src/core` store layout).
pub const MACHINES_KEY: &str = "machines";
/// The user-deleted session ids and when each was deleted.
pub const DISMISSED_SESSIONS_KEY: &str = "machines.dismissed";
pub const OUTBOX_KEY: &str = "outbox";
pub const SETTINGS_KEY: &str = "settings";
pub const QUICK_PROMPTS_KEY: &str = QUICK_PROMPTS_STORAGE_KEY;
/// The session keys, when the host keeps them in the KV (see
/// [`crate::ports::KvSessionKeyStore`]).
pub const SESSION_KEYS_KEY: &str = "session.keys";
/// Where a single session key used to be kept, in plain hex. Deleted at
/// boot: the key it held is no longer read.
pub const OLD_SESSION_KEY_KEY: &str = "session.secretKey";
/// `nostr_client`'s `last_stored_seen` cursor (seconds), persisted so a reboot
/// resumes its since-window.
pub const LAST_STORED_SEEN_KEY: &str = "client.lastStoredSeen";

/// Boot options for the store bundle.
#[derive(Debug, Clone, Default)]
pub struct StoresConfig {
    pub merge_options: MergeOptions,
    /// `0` → the store's own default (`SYNC_MAX_ATTEMPTS`).
    pub sync_max_attempts: u32,
}

/// Every `client_core` state machine the runtime drives.
pub struct CoreStores {
    pub machines: MachinesState,
    pub transcript: TranscriptState,
    pub outbox: OutboxState,
    pub pending_sessions: PendingSessionsState,
    pub pairing: PairingState,
    pub settings: SettingsState,
    pub quick_prompts: QuickPromptsState,
    pub ui: UiState,
    pub notifications: NotificationCoordinator,
    pub delete_controller: DeleteController,
}

impl CoreStores {
    /// The relays the transport dials: every paired machine's, plus a pairing
    /// candidate's, which its pair-request and pair-ack travel over.
    pub fn relay_set(&self) -> Vec<String> {
        let mut relays = self.machines.relay_set();
        for relay in self.pairing.candidate.iter().flat_map(|c| &c.relays) {
            if !relays.contains(relay) {
                relays.push(relay.clone());
            }
        }
        relays
    }

    /// Where a command for `machine` is published: its relays, or, for the
    /// pairing candidate, the relays its pairing named. Empty (every
    /// connected relay) for a machine that has none on record.
    pub fn relays_for(&self, machine: &str) -> Vec<String> {
        match self.machines.machine(machine) {
            Some(m) => m.relays.clone(),
            None => self
                .pairing
                .candidate
                .as_ref()
                .filter(|c| c.pubkey_hex == machine)
                .map(|c| c.relays.clone())
                .unwrap_or_default(),
        }
    }

    /// Human labels for notification text, resolved from the machine view —
    /// notify events themselves only carry machine/session keys. Owned, so
    /// the borrow of `machines` ends before the coordinator's `&mut` emit.
    pub fn notification_labels(&self, machine: &str, session_id: &str) -> NotificationLabels {
        let Some(mv) = self.machines.machine(machine) else {
            return NotificationLabels::default();
        };
        let session = mv.sessions.get(session_id);
        NotificationLabels {
            session: session.and_then(|sv| {
                non_blank(sv.info.title.as_deref().unwrap_or(""))
                    .or_else(|| non_blank(&sv.info.slug))
                    .map(str::to_string)
            }),
            // In capitals, as the app shows machine names everywhere.
            machine: non_blank(&mv.name).map(str::to_uppercase),
            // The catalog's display name; the bare id when the bridge has not
            // advertised the agent (yet).
            agent: session.map(|sv| {
                mv.agent(&sv.info.agent)
                    .map_or_else(|| sv.info.agent.clone(), |a| a.display_name.clone())
            }),
        }
    }
}

/// What [`CoreStores::notification_labels`] resolved; each is absent when
/// the store does not know it (yet).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct NotificationLabels {
    pub session: Option<String>,
    pub machine: Option<String>,
    pub agent: Option<String>,
}

impl NotificationLabels {
    pub fn context(&self) -> NotificationContext<'_> {
        NotificationContext {
            session_label: self.session.as_deref(),
            machine_label: self.machine.as_deref(),
            agent_label: self.agent.as_deref(),
        }
    }
}

fn non_blank(s: &str) -> Option<&str> {
    let t = s.trim();
    (!t.is_empty()).then_some(t)
}

/// What [`hydrate`] resolved from the KV.
pub struct HydratedCore {
    pub stores: CoreStores,
    /// `last_stored_seen` cursor, seconds.
    pub last_stored_seen: i64,
}

/// Read the KV + transcript store and seed every store. Never fails — a garbage
/// value yields that store's default.
pub async fn hydrate(
    kv: &dyn Kv,
    transcript_store: &dyn TranscriptStore,
    config: &StoresConfig,
) -> HydratedCore {
    let settings = SettingsState::new(hydrate_settings(kv.get(SETTINGS_KEY).await.as_deref()));
    let quick_prompts =
        QuickPromptsState::from_hydrated(hydrate_quick_prompts(kv.get(QUICK_PROMPTS_KEY).await.as_deref()));
    let mut machines = MachinesState::new(
        hydrate_machines(kv.get(MACHINES_KEY).await.as_deref()),
        config.merge_options,
    );
    machines.dismissed_sessions = hydrate_dismissed(kv.get(DISMISSED_SESSIONS_KEY).await.as_deref());
    let outbox = OutboxState::new(hydrate_outbox(kv.get(OUTBOX_KEY).await.as_deref()));

    let last_stored_seen = kv
        .get(LAST_STORED_SEEN_KEY)
        .await
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0)
        .max(0);

    // Rehydrate transcript coverage for persisted sessions so the first
    // sync-request after boot carries truthful have-ranges.
    let mut transcript = TranscriptState::new(config.sync_max_attempts);
    for (machine_pubkey, machine) in &machines.machines {
        for session_id in machine.sessions.keys() {
            let seqs = transcript_store.seqs(machine_pubkey, session_id).await;
            transcript.hydrate_from_seqs(machine_pubkey, session_id, &seqs);
        }
    }

    HydratedCore {
        stores: CoreStores {
            machines,
            transcript,
            outbox,
            pending_sessions: PendingSessionsState::default(),
            pairing: PairingState::default(),
            settings,
            quick_prompts,
            ui: UiState::default(),
            notifications: NotificationCoordinator::default(),
            delete_controller: DeleteController::default(),
        },
        last_stored_seen,
    }
}

/// Writes a store back to the KV after the runtime mutated it. Fire-and-forget:
/// the caller `.await`s but a `MemoryKv` resolves instantly and a real store's
/// failure is a log line, never a lost mutation in memory.
pub struct Persister<'a> {
    pub kv: &'a dyn Kv,
}

impl<'a> Persister<'a> {
    pub fn new(kv: &'a dyn Kv) -> Self {
        Self { kv }
    }

    pub async fn save_machines(&self, s: &MachinesState) {
        self.kv.set(MACHINES_KEY, &serialize_machines(&s.machines)).await;
        self.kv
            .set(DISMISSED_SESSIONS_KEY, &serialize_dismissed(&s.dismissed_sessions))
            .await;
    }

    pub async fn save_outbox(&self, s: &OutboxState) {
        self.kv.set(OUTBOX_KEY, &serialize_outbox(&s.items)).await;
    }

    pub async fn save_settings(&self, s: &SettingsState) {
        self.kv.set(SETTINGS_KEY, &serialize_settings(&s.data)).await;
    }

    pub async fn save_quick_prompts(&self, s: &QuickPromptsState) {
        self.kv
            .set(QUICK_PROMPTS_KEY, &serialize_quick_prompts(&s.prompts))
            .await;
    }

    pub async fn save_last_stored_seen(&self, ts: i64) {
        self.kv.set(LAST_STORED_SEEN_KEY, &ts.to_string()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{MemoryKv, MemoryTranscriptStore};
    use client_core::stores::outbox::OutboxItemState;

    #[tokio::test]
    async fn hydrate_from_an_empty_kv_gives_defaults() {
        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();
        let h = hydrate(&kv, &ts, &StoresConfig::default()).await;

        assert_eq!(h.last_stored_seen, 0);
        assert!(h.stores.machines.machines.is_empty());
        assert!(h.stores.outbox.items.is_empty());
        assert!(h.stores.quick_prompts.prompts.is_empty());
        // settings come up at their built-in defaults
        assert_eq!(h.stores.settings.data, client_core::stores::settings::default_settings());
    }

    #[tokio::test]
    async fn notification_labels_name_the_machine_in_capitals() {
        let mut s = hydrate(&MemoryKv::new(), &MemoryTranscriptStore::new(), &StoresConfig::default()).await.stores;
        s.machines.register_machine("m", "laptop-01", None, None, &[]);
        assert_eq!(s.notification_labels("m", "s").machine.as_deref(), Some("LAPTOP-01"));
        assert_eq!(s.notification_labels("unknown", "s"), NotificationLabels::default());
    }

    #[tokio::test]
    async fn persist_then_hydrate_restores_every_store() {
        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();

        let mut h = hydrate(&kv, &ts, &StoresConfig::default()).await;
        let p = Persister::new(&kv);

        // mutate a few stores + persist them
        h.stores.quick_prompts.add_prompt("qp-1", "Go", "continue");
        p.save_quick_prompts(&h.stores.quick_prompts).await;

        let item = OutboxState::new_input("in-1", "machine", "sess", "hello", 1_000);
        h.stores.outbox.begin_publish(item);
        p.save_outbox(&h.stores.outbox).await;

        p.save_last_stored_seen(1_234).await;

        // a "second Core" over the same KV
        let h2 = hydrate(&kv, &ts, &StoresConfig::default()).await;
        assert_eq!(h2.last_stored_seen, 1_234);
        assert_eq!(h2.stores.quick_prompts.prompts[0].label, "Go");
        assert_eq!(h2.stores.outbox.items["in-1"].state, OutboxItemState::Pending);
    }

    #[tokio::test]
    async fn transcript_coverage_is_rehydrated_from_the_row_store() {
        use protocol::common::RemoteSessionInfo;

        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();

        // a persisted machine with one session
        let mut machines = MachinesState::new(Default::default(), MergeOptions::default());
        machines.register_machine("m", "laptop", None, None, &[]);
        let info = RemoteSessionInfo {
            id: "s1".into(),
            agent: "claude-code".into(),
            slug: "slug-s1".into(),
            cwd: "/w".into(),
            last_activity: "1970-01-01T00:00:00.000Z".into(),
            line_count: 0,
            title: None,
            project: "p".into(),
            mode: None,
            effort: None,
            model: None,
            context_window: None,
            context_percentage: None,
            committed: None,
            state: None,
            seq_high: None,
            provider_id: None,
            provider_label: None,
        };
        machines.apply_session_upsert("m", &info, 0);
        kv.set(MACHINES_KEY, &serialize_machines(&machines.machines)).await;

        // rows already stored for that session
        use crate::ports::TranscriptRow;
        ts.insert_ignore(
            "m",
            "s1",
            &[
                TranscriptRow { seq: 1, entry: serde_json::json!({}) },
                TranscriptRow { seq: 2, entry: serde_json::json!({}) },
            ],
        )
        .await;

        let h = hydrate(&kv, &ts, &StoresConfig::default()).await;
        assert!(h.stores.transcript.has_contiguous("m", "s1", Some(2)));
    }
}
