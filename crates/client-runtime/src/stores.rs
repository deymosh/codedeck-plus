//! `CoreStores` — the bundle of `client_core` state machines the runtime owns,
//! with KV hydrate on boot and re-serialize after a mutation.
//!
//! The pure stores never touch the [`Kv`] / [`TranscriptStore`] ports; this
//! module reads them on boot to seed each store and writes a store back after
//! the runtime applies a mutation to it. Storage keys match the legacy
//! `apps/mobile/src/core` layout so an in-place upgrade keeps its data.

use protocol::crypto::Keypair;
use client_core::default_session_mode::DefaultModeApplier;
use client_core::delete_controller::DeleteController;
use client_core::notifications::NotificationCoordinator;
use client_core::stores::dm::{hydrate_dm, serialize_dm, DmState, DM_STORAGE_KEY};
use client_core::stores::identity::{load_or_create_identity, IDENTITY_STORAGE_KEY};
use client_core::stores::machines::{
    hydrate_machines, serialize_machines, MachinesState, MergeOptions,
};
use client_core::stores::marmot::{hydrate_marmot, serialize_marmot, MarmotState, MARMOT_STORAGE_KEY};
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
pub const OUTBOX_KEY: &str = "outbox";
pub const SETTINGS_KEY: &str = "settings";
pub const QUICK_PROMPTS_KEY: &str = QUICK_PROMPTS_STORAGE_KEY;
pub const DM_KEY: &str = DM_STORAGE_KEY;
pub const MARMOT_KEY: &str = MARMOT_STORAGE_KEY;
pub const IDENTITY_KEY: &str = IDENTITY_STORAGE_KEY;
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
    pub dm: DmState,
    pub marmot: MarmotState,
    pub notifications: NotificationCoordinator,
    pub delete_controller: DeleteController,
    pub default_mode: DefaultModeApplier,
}

/// What [`hydrate`] resolved from the KV.
pub struct HydratedCore {
    pub stores: CoreStores,
    /// The install identity (fresh on first boot, else the stored secret).
    pub keypair: Keypair,
    /// The stored identity secret was absent or corrupt — persist the new one.
    pub identity_needs_persist: bool,
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
    let identity = load_or_create_identity(kv.get(IDENTITY_KEY).await.as_deref());

    let settings = SettingsState::new(hydrate_settings(kv.get(SETTINGS_KEY).await.as_deref()));
    let quick_prompts =
        QuickPromptsState::from_hydrated(hydrate_quick_prompts(kv.get(QUICK_PROMPTS_KEY).await.as_deref()));
    let machines = MachinesState::new(
        hydrate_machines(kv.get(MACHINES_KEY).await.as_deref()),
        config.merge_options,
    );
    let outbox = OutboxState::new(hydrate_outbox(kv.get(OUTBOX_KEY).await.as_deref()));
    let dm = DmState::from_persisted(hydrate_dm(kv.get(DM_KEY).await.as_deref()));
    let marmot = MarmotState::from_persisted(hydrate_marmot(kv.get(MARMOT_KEY).await.as_deref()));

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
            dm,
            marmot,
            notifications: NotificationCoordinator::default(),
            delete_controller: DeleteController::default(),
            default_mode: DefaultModeApplier::default(),
        },
        keypair: identity.keypair,
        identity_needs_persist: identity.needs_persist,
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

    pub async fn save_dm(&self, s: &DmState) {
        self.kv.set(DM_KEY, &serialize_dm(&s.to_persisted())).await;
    }

    pub async fn save_marmot(&self, s: &MarmotState) {
        self.kv
            .set(MARMOT_KEY, &serialize_marmot(&s.to_persisted()))
            .await;
    }

    pub async fn save_identity_secret(&self, keypair: &Keypair) {
        self.kv.set(IDENTITY_KEY, &keypair.secret_hex()).await;
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
    async fn hydrate_from_an_empty_kv_gives_defaults_and_a_fresh_identity() {
        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();
        let h = hydrate(&kv, &ts, &StoresConfig::default()).await;

        assert!(h.identity_needs_persist);
        assert_eq!(h.keypair.pubkey_hex.len(), 64);
        assert_eq!(h.last_stored_seen, 0);
        assert!(h.stores.machines.machines.is_empty());
        assert!(h.stores.outbox.items.is_empty());
        assert!(h.stores.dm.conversations.is_empty());
        assert!(h.stores.quick_prompts.prompts.is_empty());
        // settings come up at their built-in defaults (5 relays)
        assert_eq!(h.stores.settings.data.relays.len(), 5);
    }

    #[tokio::test]
    async fn persist_then_hydrate_restores_every_store() {
        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();

        let mut h = hydrate(&kv, &ts, &StoresConfig::default()).await;
        let p = Persister::new(&kv);
        p.save_identity_secret(&h.keypair).await;

        // mutate a few stores + persist them
        h.stores.quick_prompts.add_prompt("qp-1", "Go", "continue");
        p.save_quick_prompts(&h.stores.quick_prompts).await;

        let peer = "2".repeat(64);
        let item = OutboxState::new_input("in-1", "machine", "sess", "hello", 1_000);
        h.stores.outbox.begin_publish(item);
        p.save_outbox(&h.stores.outbox).await;

        h.stores.dm.add_message(
            client_core::stores::dm::DmMessage {
                id: "r1".into(),
                peer_pubkey: peer.clone(),
                sender_pubkey: peer.clone(),
                content: "hi".into(),
                at: 5_000,
                status: client_core::stores::dm::DmMessageStatus::Delivered,
            },
            &h.keypair.pubkey_hex,
        );
        p.save_dm(&h.stores.dm).await;

        p.save_last_stored_seen(1_234).await;

        // a "second Core" over the same KV
        let h2 = hydrate(&kv, &ts, &StoresConfig::default()).await;
        assert!(!h2.identity_needs_persist);
        assert_eq!(h2.keypair.pubkey_hex, h.keypair.pubkey_hex);
        assert_eq!(h2.last_stored_seen, 1_234);
        assert_eq!(h2.stores.quick_prompts.prompts[0].label, "Go");
        assert_eq!(h2.stores.outbox.items["in-1"].state, OutboxItemState::Pending);
        assert_eq!(h2.stores.dm.conversations[&peer].last_preview, "hi");
    }

    #[tokio::test]
    async fn transcript_coverage_is_rehydrated_from_the_row_store() {
        use protocol::common::RemoteSessionInfo;

        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();

        // a persisted machine with one session
        let mut machines = MachinesState::new(Default::default(), MergeOptions::default());
        machines.register_machine("m", "laptop", None, None);
        let info = RemoteSessionInfo {
            id: "s1".into(),
            slug: "slug-s1".into(),
            cwd: "/w".into(),
            last_activity: "1970-01-01T00:00:00.000Z".into(),
            line_count: 0,
            title: None,
            project: "p".into(),
            permission_mode: None,
            effort_level: None,
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
