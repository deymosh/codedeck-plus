//! The loop's side of the config backup: following the backup on its
//! relay, merging each version another device saves, saving this device's
//! changes, and turning it off. The events themselves are
//! `crate::backup`'s; the payload and the merge are
//! `client_core::stores::backup`'s.
//!
//! While backup is on and the core runs, the loop holds a subscription to
//! the identity's backup on the backup relay. Each newer version (not one
//! this device saved) is opened through the signer and merged at once: the
//! machines and quick prompts another device added, changed or removed
//! reach this one. When this device then holds anything newer than that
//! version, it saves the merge. A local change is saved a while after the
//! last one, and only when what the backup would hold changed. A relay with
//! no backup yet gets this device's.

use std::time::Duration;

use client_core::stores::backup::{backup_d_tag, backup_fingerprint, build_backup, merge_backup, ConfigBackup, BACKUP_KIND};
use client_core::stores::pairing::is_relay_url;
use nostr_transport::{Filter, SubCallbacks, Transport};
use tokio::sync::oneshot;

use super::{abort, IntentCtx, Loop, Msg, SignerJob};
use crate::backup::BackupStatus;
use crate::dispatch::StoreId;
use crate::intent::{apply as apply_intent, Intent};
use crate::nostr_client::NostrEvent;
use crate::stores::Persister;
use crate::transport::ws::{PUBLISH_CONFIRM_ATTEMPTS, PUBLISH_CONFIRM_BUDGET};
use super::SliceId;

/// How long after the last change a backup is saved: a burst of edits (or
/// the heartbeats a pairing brings) costs one event.
const SAVE_AFTER: Duration = Duration::from_secs(30);

/// What opening a version of the backup gave.
pub(super) type Fetched = Result<ConfigBackup, String>;

/// A save that reached the relay: when, what it held, and its event.
pub(super) struct Saved {
    pub at: u64,
    pub machines: u32,
    pub fingerprint: String,
    pub event_id: String,
    pub created_at: u64,
}

impl Loop {
    /// Take a backup intent; any other comes back for the stores.
    pub(super) async fn on_backup_intent(&mut self, intent: Intent) -> Option<Intent> {
        match intent {
            Intent::SetBackupRelay(url) => self.set_backup_relay(url.trim()).await,
            Intent::BackupNow => self.save_backup(true),
            Intent::DisableBackup { delete } => self.disable_backup(delete).await,
            other => return Some(other),
        }
        self.state_changed(SliceId::Settings);
        None
    }

    async fn set_backup_relay(&mut self, relay: &str) {
        if !is_relay_url(relay) {
            self.stores.backup.status =
                BackupStatus::Failed { reason: "Enter a relay address that starts with wss://.".into() };
            return;
        }
        abort(&mut self.backup_timer);
        let backup = &mut self.stores.backup;
        backup.config.relay = Some(relay.to_string());
        backup.config.saved_at = None;
        backup.config.fingerprint = None;
        Persister::new(self.kv.as_ref()).save_backup(&self.stores.backup).await;
        self.sync_relays();
        self.close_backup_sub();
        self.sync_backup_sub();
    }

    /// Hold the subscription to the backup while backup is on and the core
    /// runs; drop it otherwise.
    pub(super) fn sync_backup_sub(&mut self) {
        let wanted = self.links_on && self.stores.backup.config.relay.is_some();
        if !wanted {
            self.close_backup_sub();
            return;
        }
        if self.backup_sub.is_some() {
            return;
        }
        let me = self.signer.pubkey_hex();
        self.stores.backup.status = BackupStatus::Checking;
        self.backup_heard = false;
        self.backup_seen_at = 0;
        let (events, eose) = (self.self_tx.clone(), self.self_tx.clone());
        self.backup_sub = Some(self.ws.subscribe(
            Filter {
                kinds: vec![BACKUP_KIND],
                authors: vec![me.clone()],
                p_tags: vec![],
                d_tags: vec![backup_d_tag(&me)],
                c_tags: vec![],
                since: None,
            },
            SubCallbacks {
                on_event: std::rc::Rc::new(move |e: &NostrEvent| {
                    let _ = events.send(Msg::BackupEvent(e.clone()));
                }),
                on_eose: std::rc::Rc::new(move || {
                    let _ = eose.send(Msg::BackupEose);
                }),
                on_close: std::rc::Rc::new(|_| {}),
            },
        ));
    }

    fn close_backup_sub(&mut self) {
        if let Some(sub) = self.backup_sub.take() {
            sub.close();
        }
    }

    /// A version of the backup arrived: open it, unless it is not newer
    /// than one already seen or it is this device's own save.
    pub(super) fn on_backup_event(&mut self, event: NostrEvent) {
        let me = self.signer.pubkey_hex();
        if event.kind != BACKUP_KIND || !event.pubkey.eq_ignore_ascii_case(&me) || event.created_at <= self.backup_seen_at {
            return;
        }
        self.backup_seen_at = event.created_at;
        if self.backup_own.as_deref() == Some(event.id.as_str()) {
            return;
        }
        let jobs = self.signer_jobs.clone();
        let tx = self.self_tx.clone();
        tokio::task::spawn_local(async move {
            let (reply, answer) = oneshot::channel();
            let _ = jobs.send(SignerJob::OpenBackup { event, reply });
            let opened = answer.await.unwrap_or_else(|_| Err("The backup could not be read.".into()));
            let _ = tx.send(Msg::BackupFetched(opened));
        });
    }

    /// The relay sent what it has: with nothing there, this device's is the
    /// first backup.
    pub(super) fn on_backup_eose(&mut self) {
        if std::mem::replace(&mut self.backup_heard, true) {
            return;
        }
        if self.backup_seen_at == 0 {
            self.stores.backup.status = BackupStatus::Idle;
            self.save_backup(true);
            self.state_changed(SliceId::Settings);
        }
    }

    /// Merge a version another device saved; save the result when this
    /// device holds anything newer.
    pub(super) async fn on_backup_fetched(&mut self, found: Fetched) {
        let backup = match found {
            Ok(backup) => backup,
            Err(reason) => {
                self.stores.backup.status = BackupStatus::Failed { reason };
                self.state_changed(SliceId::Settings);
                return;
            }
        };
        let now = self.clock.now_ms();
        let stores = &mut self.stores;
        let outcome = merge_backup(&backup, &mut stores.machines, &mut stores.quick_prompts, &mut stores.backup.config.sync, now);
        log::info!(
            "backup: merged ({} machines added, {} updated, {} removed, quick prompts {})",
            outcome.added,
            outcome.updated,
            outcome.removed.len(),
            if outcome.prompts_changed { "taken" } else { "kept" }
        );
        // Removed on another device: removed here as a removal from this
        // device would be, with what is kept about the machine.
        for pubkey_hex in outcome.removed {
            let ctx = IntentCtx { now, visible: self.conn.visible };
            let result = apply_intent(&mut self.stores, Intent::RemoveMachine { pubkey_hex }, &self.keys, ctx);
            self.interpret_intent(result).await;
        }
        if outcome.added + outcome.updated > 0 {
            self.persist_store(StoreId::Machines).await;
            self.state_changed(SliceId::Machines);
        }
        if outcome.prompts_changed {
            self.persist_store(StoreId::QuickPrompts).await;
            self.state_changed(super::slice_of(StoreId::QuickPrompts));
        }
        self.sync_relays();
        self.refresh_authors();
        self.sync_direct_links();
        let theirs = backup_fingerprint(&backup);
        self.stores.backup.config.fingerprint = Some(theirs.clone());
        self.stores.backup.config.saved_at = Some(backup.saved_at);
        self.stores.backup.config.machines = Some(u32::try_from(backup.machines.len()).unwrap_or(u32::MAX));
        if !self.backup_busy {
            self.stores.backup.status = BackupStatus::Idle;
        }
        Persister::new(self.kv.as_ref()).save_backup(&self.stores.backup).await;
        let ours = build_backup(&self.stores.machines, &self.stores.quick_prompts.prompts, &self.stores.backup.config.sync, now);
        if backup_fingerprint(&ours) != theirs {
            self.save_backup(false);
        }
        self.state_changed(SliceId::Settings);
    }

    async fn disable_backup(&mut self, delete: bool) {
        abort(&mut self.backup_timer);
        self.close_backup_sub();
        match self.stores.backup.config.relay.clone() {
            Some(relay) if delete => {
                self.backup_busy = true;
                self.stores.backup.status = BackupStatus::Saving;
                let ws = self.ws.clone();
                let jobs = self.signer_jobs.clone();
                let tx = self.self_tx.clone();
                let created_at = self.next_backup_created_at();
                tokio::task::spawn_local(async move {
                    let (reply, answer) = oneshot::channel();
                    let _ = jobs.send(SignerJob::SealDeletion { created_at, reply });
                    if let Ok(Ok(event)) = answer.await {
                        let result = ws.publish_confirmed_to(&event, &[relay], PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS).await;
                        if !result.verdict.is_delivered() {
                            log::warn!("backup: deletion not delivered: {:?} {:?}", result.verdict, result.detail);
                        }
                    }
                    let _ = tx.send(Msg::BackupDeleted);
                });
            }
            _ => self.forget_backup_relay().await,
        }
    }

    /// Backup is off on this device: its relay and its part in the backup
    /// are forgotten, so turning it on again joins like a new device.
    pub(super) async fn forget_backup_relay(&mut self) {
        self.backup_busy = false;
        self.close_backup_sub();
        let backup = &mut self.stores.backup;
        backup.config = Default::default();
        backup.status = BackupStatus::Idle;
        Persister::new(self.kv.as_ref()).save_backup(&self.stores.backup).await;
        self.sync_relays();
        self.state_changed(SliceId::Settings);
    }

    /// Something worth backing up changed: save in a while.
    pub(super) fn backup_changed(&mut self) {
        if self.stores.backup.config.relay.is_some() && self.backup_timer.is_none() {
            self.backup_timer = Some(self.arm(SAVE_AFTER.as_millis() as u64, Msg::BackupDue));
        }
    }

    pub(super) fn on_backup_due(&mut self) {
        self.backup_timer = None;
        self.save_backup(false);
        self.state_changed(SliceId::Settings);
    }

    /// Save the backup now, unless `force` is off and it holds what the
    /// relay already has. Never before the relay said what it has (a new
    /// device must merge first, not overwrite), nor while another save runs
    /// (a change meanwhile is saved after it).
    fn save_backup(&mut self, force: bool) {
        let Some(relay) = self.stores.backup.config.relay.clone() else { return };
        if !self.backup_heard {
            return;
        }
        if self.backup_busy {
            self.backup_changed();
            return;
        }
        let now = self.clock.now_ms();
        let stores = &mut self.stores;
        stores.backup.config.sync.note_local_changes(&stores.machines, &stores.quick_prompts.prompts, now);
        let backup = build_backup(&stores.machines, &stores.quick_prompts.prompts, &stores.backup.config.sync, now);
        let fingerprint = backup_fingerprint(&backup);
        let machines = u32::try_from(backup.machines.len()).unwrap_or(u32::MAX);
        if !force && stores.backup.config.fingerprint.as_deref() == Some(fingerprint.as_str()) {
            return;
        }
        self.backup_busy = true;
        self.stores.backup.status = BackupStatus::Saving;
        let created_at = self.next_backup_created_at();
        let ws = self.ws.clone();
        let jobs = self.signer_jobs.clone();
        let tx = self.self_tx.clone();
        tokio::task::spawn_local(async move {
            let (reply, answer) = oneshot::channel();
            let _ = jobs.send(SignerJob::SealBackup { backup: Box::new(backup), created_at, reply });
            let saved = match answer.await.unwrap_or_else(|_| Err("The backup could not be sealed.".into())) {
                Ok(event) => {
                    let result = ws.publish_confirmed_to(&event, &[relay], PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS).await;
                    if result.verdict.is_delivered() {
                        Ok(Saved { at: now, machines, fingerprint, event_id: event.id.clone(), created_at })
                    } else {
                        Err(match result.detail {
                            Some(detail) => format!("The relay did not take the backup: {detail}"),
                            None => "The backup relay could not be reached.".into(),
                        })
                    }
                }
                Err(reason) => Err(reason),
            };
            let _ = tx.send(Msg::BackupSaved(saved));
        });
    }

    pub(super) async fn on_backup_saved(&mut self, saved: Result<Saved, String>) {
        self.backup_busy = false;
        match saved {
            Ok(saved) => {
                self.stores.backup.config.saved_at = Some(saved.at);
                self.stores.backup.config.machines = Some(saved.machines);
                self.stores.backup.config.fingerprint = Some(saved.fingerprint);
                self.stores.backup.status = BackupStatus::Idle;
                // Its own save comes back on the subscription: nothing to open.
                self.backup_own = Some(saved.event_id);
                self.backup_seen_at = self.backup_seen_at.max(i64::try_from(saved.created_at).unwrap_or(i64::MAX));
                Persister::new(self.kv.as_ref()).save_backup(&self.stores.backup).await;
            }
            Err(reason) => {
                log::warn!("backup: {reason}");
                self.stores.backup.status = BackupStatus::Failed { reason };
            }
        }
        self.state_changed(SliceId::Settings);
    }

    /// A relay keeps the newest backup and, between two of the same second,
    /// the one with the lower id: each one is dated past the last seen.
    fn next_backup_created_at(&mut self) -> u64 {
        let seen = u64::try_from(self.backup_seen_at).unwrap_or(0);
        let at = (self.clock.now_ms() / 1000).max(self.backup_created_at + 1).max(seen + 1);
        self.backup_created_at = at;
        at
    }
}
