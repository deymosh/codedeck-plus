//! The loop's side of the config backup: following the backup on its
//! relay, merging each version another device saves, saving this device's
//! changes, and turning it off. The events themselves are
//! `crate::backup`'s; the payload and the merge are
//! `client_core::stores::backup`'s.
//!
//! While backup is on and the core runs, the loop holds a subscription to
//! the identity's backup on the backup relay, and on that relay only. Each
//! newer version (not one this device saved) is opened through the signer
//! and merged at once: the machines and quick prompts another device added,
//! changed or removed reach this one. A change, this device's own or what a
//! merge leaves newer here than on the relay, is saved a while after the
//! last one, and only when what the backup would hold changed. A relay with
//! no backup yet gets this device's.
//!
//! Nothing is saved before the relay said what it holds, nor while a
//! version is being opened, nor over one that could not be opened: a device
//! merges before it writes, and never writes over what it cannot read. A
//! relay that does not answer, or ends the subscription, shows as a failure
//! and is subscribed to again, waiting longer each time.
//!
//! Deleting the backup leaves an empty version at its address. A device
//! that took part before that version turns backup off when it sees it; one
//! joining afterwards finds no backup and saves its own.

use std::time::Duration;

use client_core::stores::backup::{backup_d_tag, backup_fingerprint, build_backup, merge_backup, ConfigBackup, BACKUP_KIND};
use client_core::stores::pairing::is_relay_url;
use client_core::stores::terminals::InputTransport;
use nostr_transport::{Filter, SubCallbacks, Transport};
use tokio::sync::oneshot;

use super::{abort, IntentCtx, Loop, Msg, SignerJob};
use crate::backup::{is_removed, BackupStatus};
use crate::dispatch::StoreId;
use crate::intent::{apply as apply_intent, Intent};
use crate::nostr_client::NostrEvent;
use crate::stores::Persister;
use crate::transport::ws::{PUBLISH_CONFIRM_ATTEMPTS, PUBLISH_CONFIRM_BUDGET};
use super::SliceId;
use client_core::connection::ConnectionStatus;

/// How long after the last change a backup is saved: a burst of edits (or
/// the heartbeats a pairing brings) costs one event.
const SAVE_AFTER: Duration = Duration::from_secs(30);
/// How long the backup relay has to say what it holds before the page says
/// it does not answer (the subscription stays: a late answer still counts).
const ANSWER_WAIT: Duration = Duration::from_secs(20);
/// The first and the longest wait before subscribing again to a backup
/// relay that ended the subscription.
const RETRY_FIRST: Duration = Duration::from_secs(30);
const RETRY_MAX: Duration = Duration::from_secs(15 * 60);

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
            Intent::BackupNow => self.backup_now(),
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
        backup.config.seen_at = 0;
        Persister::new(self.kv.as_ref()).save_backup(&self.stores.backup).await;
        self.forget_backup_seen();
        self.sync_relays();
        self.resubscribe_backup();
    }

    /// "Back up now": save at once if the relay answered, else ask it again
    /// (and try again to open a version that could not be opened).
    fn backup_now(&mut self) {
        if self.backup_heard && !self.backup_unreadable {
            self.save_backup(true);
        } else {
            if self.backup_unreadable {
                self.forget_backup_seen();
            }
            self.resubscribe_backup();
        }
    }

    /// Subscribe to the backup afresh, now, whatever the last one did.
    fn resubscribe_backup(&mut self) {
        abort(&mut self.backup_retry_timer);
        self.backup_retry_ms = 0;
        self.close_backup_sub();
        self.sync_backup_sub();
    }

    /// Hold the subscription to the backup while backup is on and the core
    /// runs; drop it otherwise.
    pub(super) fn sync_backup_sub(&mut self) {
        let relay = match &self.stores.backup.config.relay {
            Some(relay) if self.links_on => relay.clone(),
            _ => {
                abort(&mut self.backup_retry_timer);
                self.close_backup_sub();
                return;
            }
        };
        if self.backup_sub.is_some() || self.backup_retry_timer.is_some() {
            return;
        }
        let me = self.signer.pubkey_hex();
        self.stores.backup.status = BackupStatus::Checking;
        self.backup_found = false;
        // What an earlier run saw is not news (nor opened again).
        self.backup_seen_at = self.backup_seen_at.max(self.stores.backup.config.seen_at);
        self.backup_sub_seq += 1;
        let sub = self.backup_sub_seq;
        let (events, eose, closed) = (self.self_tx.clone(), self.self_tx.clone(), self.self_tx.clone());
        self.backup_sub = Some(self.ws.subscribe_to(
            std::slice::from_ref(&relay),
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
                    let _ = eose.send(Msg::BackupEose { sub });
                }),
                on_close: std::rc::Rc::new(move |reason| {
                    let _ = closed.send(Msg::BackupClosed { sub, reason });
                }),
            },
        ));
        self.backup_wait_timer = Some(self.arm(ANSWER_WAIT.as_millis() as u64, Msg::BackupNoAnswer { sub }));
    }

    fn close_backup_sub(&mut self) {
        abort(&mut self.backup_wait_timer);
        self.backup_heard = false;
        if let Some(sub) = self.backup_sub.take() {
            sub.close();
        }
    }

    /// Forget which versions were seen, and drop what is being opened or
    /// saved: the relay is another one, or none.
    fn forget_backup_seen(&mut self) {
        self.backup_epoch += 1;
        self.backup_opening = 0;
        self.backup_seen_at = 0;
        self.backup_seen_ids.clear();
        self.backup_unreadable = false;
    }

    /// A version of the backup arrived: open it, unless it was seen already
    /// (this device's own save among them). The empty version a deletion
    /// leaves turns backup off here, if this device took part before it:
    /// it has taken part, and the deletion is newer than every version it
    /// has seen. A device joining afterwards sees it as the newest it knows
    /// and saves its own over it.
    pub(super) async fn on_backup_event(&mut self, event: NostrEvent) {
        let me = self.signer.pubkey_hex();
        if event.kind != BACKUP_KIND || !event.pubkey.eq_ignore_ascii_case(&me) {
            return;
        }
        let removed = is_removed(&event);
        self.backup_found |= !removed;
        if !self.note_backup_seen(event.created_at, &event.id) {
            return;
        }
        if removed {
            if self.stores.backup.config.sync.since.is_some() {
                log::info!("backup: deleted on another device; turning it off here");
                abort(&mut self.backup_timer);
                self.forget_backup_relay().await;
                self.stores.backup.status =
                    BackupStatus::Failed { reason: "The backup was turned off and deleted on another device.".into() };
                self.state_changed(SliceId::Settings);
            }
            return;
        }
        self.backup_opening += 1;
        let jobs = self.signer_jobs.clone();
        let tx = self.self_tx.clone();
        let epoch = self.backup_epoch;
        tokio::task::spawn_local(async move {
            let (reply, answer) = oneshot::channel();
            let _ = jobs.send(SignerJob::OpenBackup { event, reply });
            let found = answer.await.unwrap_or_else(|_| Err("The backup could not be read.".into()));
            let _ = tx.send(Msg::BackupFetched { epoch, found });
        });
    }

    /// Note a version as seen; whether it is newer than all seen before. Two
    /// versions of the same second are told apart by their ids.
    fn note_backup_seen(&mut self, created_at: i64, id: &str) -> bool {
        if created_at < self.backup_seen_at || (created_at == self.backup_seen_at && self.backup_seen_ids.iter().any(|s| s == id)) {
            return false;
        }
        if created_at > self.backup_seen_at {
            self.backup_seen_at = created_at;
            self.backup_seen_ids.clear();
            self.stores.backup.config.seen_at = created_at;
        }
        self.backup_seen_ids.push(id.to_string());
        true
    }

    /// The relay sent what it has: with no backup there, this device's is
    /// the first. Otherwise what this device changed meanwhile is saved
    /// after the merge.
    pub(super) fn on_backup_eose(&mut self, sub: u64) {
        if sub != self.backup_sub_seq || self.backup_sub.is_none() {
            return;
        }
        abort(&mut self.backup_wait_timer);
        if std::mem::replace(&mut self.backup_heard, true) {
            return;
        }
        self.backup_retry_ms = 0;
        if !self.backup_busy && !self.backup_unreadable {
            self.stores.backup.status = BackupStatus::Idle;
        }
        if self.backup_found {
            self.backup_changed();
        } else {
            self.save_backup(true);
        }
        self.state_changed(SliceId::Settings);
    }

    pub(super) fn on_backup_no_answer(&mut self, sub: u64) {
        if sub != self.backup_sub_seq || self.backup_heard || self.backup_sub.is_none() {
            return;
        }
        self.backup_wait_timer = None;
        self.stores.backup.status = BackupStatus::Failed { reason: "The backup relay does not answer.".into() };
        self.state_changed(SliceId::Settings);
    }

    /// The relay ended the subscription (refused it, or every socket to it
    /// dropped): say so, and subscribe again in a while.
    pub(super) fn on_backup_closed(&mut self, sub: u64, reason: Option<String>) {
        if sub != self.backup_sub_seq || self.backup_sub.is_none() {
            return;
        }
        log::warn!("backup: subscription closed: {reason:?}");
        self.close_backup_sub();
        if !self.backup_busy {
            self.stores.backup.status = BackupStatus::Failed {
                reason: match reason {
                    Some(reason) => format!("The backup relay stopped answering: {reason}"),
                    None => "The backup relay stopped answering.".into(),
                },
            };
        }
        let wait = match self.backup_retry_ms {
            0 => RETRY_FIRST.as_millis() as u64,
            ms => (ms * 2).min(RETRY_MAX.as_millis() as u64),
        };
        self.backup_retry_ms = wait;
        self.backup_retry_timer = Some(self.arm(wait, Msg::BackupRetry));
        self.state_changed(SliceId::Settings);
    }

    /// Merge a version another device saved; what this device then holds
    /// newer is saved in a while.
    pub(super) async fn on_backup_fetched(&mut self, epoch: u64, found: Fetched) {
        if epoch != self.backup_epoch {
            return;
        }
        self.backup_opening = self.backup_opening.saturating_sub(1);
        let backup = match found {
            Ok(backup) => backup,
            Err(reason) => {
                self.backup_unreadable = true;
                self.stores.backup.status = BackupStatus::Failed { reason };
                self.state_changed(SliceId::Settings);
                return;
            }
        };
        self.backup_unreadable = false;
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
            let ctx = IntentCtx { now, visible: self.conn.visible, terminal_transport: InputTransport::Direct };
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
        // A machine new here hears from this client first by its grant, so
        // it never has to speak to the identity.
        if outcome.added > 0 && self.conn.status == ConnectionStatus::Connected {
            for machine in self.stores.machines.machine_pubkeys() {
                self.grant_if_due(&machine);
            }
        }
        self.stores.backup.config.fingerprint = Some(backup_fingerprint(&backup));
        self.stores.backup.config.saved_at = Some(backup.saved_at);
        self.stores.backup.config.machines = Some(u32::try_from(backup.machines.len()).unwrap_or(u32::MAX));
        if !self.backup_busy {
            self.stores.backup.status = BackupStatus::Idle;
        }
        Persister::new(self.kv.as_ref()).save_backup(&self.stores.backup).await;
        // Debounced: two devices that keep disagreeing cost an event per
        // `SAVE_AFTER`, not a loop as fast as the relay answers.
        self.backup_changed();
        self.state_changed(SliceId::Settings);
    }

    async fn disable_backup(&mut self, delete: bool) {
        abort(&mut self.backup_timer);
        abort(&mut self.backup_retry_timer);
        self.close_backup_sub();
        match self.stores.backup.config.relay.clone() {
            Some(relay) if delete => {
                self.backup_busy = true;
                self.stores.backup.status = BackupStatus::Saving;
                let ws = self.ws.clone();
                let jobs = self.signer_jobs.clone();
                let tx = self.self_tx.clone();
                // The deletion first, so it does not take the empty version
                // dated after it.
                let deletion_at = self.next_backup_created_at();
                let removed_at = self.next_backup_created_at();
                // What was being opened or saved is dropped when it ends.
                self.forget_backup_seen();
                tokio::task::spawn_local(async move {
                    let (reply, answer) = oneshot::channel();
                    let _ = jobs.send(SignerJob::SealDeletion { created_at: deletion_at, reply });
                    let (removed_reply, removed) = oneshot::channel();
                    let _ = jobs.send(SignerJob::SealRemoved { created_at: removed_at, reply: removed_reply });
                    for (what, answer) in [("deletion", answer), ("empty version", removed)] {
                        if let Ok(Ok(event)) = answer.await {
                            let result =
                                ws.publish_confirmed_to(&event, std::slice::from_ref(&relay), PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS).await;
                            if !result.verdict.is_delivered() {
                                log::warn!("backup: {what} not delivered: {:?} {:?}", result.verdict, result.detail);
                            }
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
        abort(&mut self.backup_retry_timer);
        self.close_backup_sub();
        self.forget_backup_seen();
        let backup = &mut self.stores.backup;
        backup.config = Default::default();
        backup.status = BackupStatus::Idle;
        Persister::new(self.kv.as_ref()).save_backup(&self.stores.backup).await;
        self.sync_relays();
        self.state_changed(SliceId::Settings);
    }

    /// Something worth backing up changed: save in a while.
    pub(super) fn backup_changed(&mut self) {
        if self.stores.backup.config.relay.is_some() && self.links_on && self.backup_timer.is_none() {
            self.backup_timer = Some(self.arm(SAVE_AFTER.as_millis() as u64, Msg::BackupDue));
        }
    }

    pub(super) fn on_backup_due(&mut self) {
        self.backup_timer = None;
        self.save_backup(false);
        self.state_changed(SliceId::Settings);
    }

    /// Save the backup now, unless `force` is off and it holds what the
    /// relay already has. Only while the core runs and after the relay said
    /// what it has (a new device must merge first, not overwrite); never
    /// over a version that could not be opened. While another save runs or
    /// a version is being opened, it is put off.
    fn save_backup(&mut self, force: bool) {
        let Some(relay) = self.stores.backup.config.relay.clone() else { return };
        if !self.links_on || !self.backup_heard || self.backup_unreadable {
            return;
        }
        if self.backup_busy || self.backup_opening > 0 {
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
        let epoch = self.backup_epoch;
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
            let _ = tx.send(Msg::BackupSaved { epoch, saved });
        });
    }

    pub(super) async fn on_backup_saved(&mut self, epoch: u64, saved: Result<Saved, String>) {
        if epoch != self.backup_epoch {
            return;
        }
        self.backup_busy = false;
        match saved {
            Ok(saved) => {
                self.stores.backup.config.saved_at = Some(saved.at);
                self.stores.backup.config.machines = Some(saved.machines);
                self.stores.backup.config.fingerprint = Some(saved.fingerprint);
                self.stores.backup.status = BackupStatus::Idle;
                // Its own save comes back on the subscription: nothing to open.
                self.note_backup_seen(i64::try_from(saved.created_at).unwrap_or(i64::MAX), &saved.event_id);
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
