//! The loop's side of the config backup: when to look for one, when to save
//! one, importing and turning it off. The events themselves are
//! `crate::backup`'s; the payload is `client_core::stores::backup`'s.
//!
//! A backup is saved a while after the last change worth backing up (a
//! paired machine, the settings, the quick prompts), and only when what it
//! holds changed. Nothing is saved while a backup found on the relay waits
//! for the user to import it or keep this phone's, so a new phone never
//! overwrites the backup it is about to restore.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use client_core::stores::backup::{backup_d_tag, backup_fingerprint, build_backup, merge_backup, ConfigBackup, BACKUP_KIND};
use client_core::stores::pairing::is_relay_url;
use nostr_transport::{Filter, SubCallbacks, Transport};
use tokio::sync::oneshot;

use super::{abort, Loop, Msg, SignerJob};
use crate::backup::{newest_backup, BackupStatus};
use crate::dispatch::StoreId;
use crate::intent::Intent;
use crate::nostr_client::NostrEvent;
use crate::stores::Persister;
use crate::transport::ws::{WsTransport, PUBLISH_CONFIRM_ATTEMPTS, PUBLISH_CONFIRM_BUDGET};
use super::SliceId;

/// How long after the last change a backup is saved: a burst of edits (or
/// the heartbeats a pairing brings) costs one event.
const SAVE_AFTER: Duration = Duration::from_secs(30);
/// How long to wait for the backup relay to come up before looking on it.
const RELAY_WAIT: Duration = Duration::from_secs(20);
/// How long a look on the relay may take once it is up.
const FETCH_BUDGET: Duration = Duration::from_secs(15);

/// What a look on the relay found.
pub(super) type Fetched = Result<Option<ConfigBackup>, String>;

impl Loop {
    /// Take a backup intent; any other comes back for the stores.
    pub(super) async fn on_backup_intent(&mut self, intent: Intent) -> Option<Intent> {
        match intent {
            Intent::SetBackupRelay(url) => self.set_backup_relay(url.trim()).await,
            Intent::ImportBackup => self.import_backup().await,
            Intent::KeepLocalConfig => {
                if self.stores.backup.found.take().is_some() {
                    self.save_backup(true);
                }
            }
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
        backup.found = None;
        Persister::new(self.kv.as_ref()).save_backup(&self.stores.backup).await;
        self.sync_relays();
        self.fetch_backup();
    }

    /// Look on the backup relay for this identity's backup.
    fn fetch_backup(&mut self) {
        let Some(relay) = self.stores.backup.config.relay.clone() else { return };
        self.backup_busy = true;
        self.stores.backup.status = BackupStatus::Checking;
        let ws = self.ws.clone();
        let me = self.signer.pubkey_hex();
        let jobs = self.signer_jobs.clone();
        let tx = self.self_tx.clone();
        tokio::task::spawn_local(async move {
            let found = match fetch_event(&ws, &relay, &me).await {
                Ok(None) => Ok(None),
                Ok(Some(event)) => {
                    let (reply, answer) = oneshot::channel();
                    let _ = jobs.send(SignerJob::OpenBackup { event, reply });
                    answer.await.unwrap_or_else(|_| Err("The backup could not be read.".into())).map(Some)
                }
                Err(reason) => Err(reason),
            };
            let _ = tx.send(Msg::BackupFetched(found));
        });
    }

    pub(super) fn on_backup_fetched(&mut self, found: Fetched) {
        self.backup_busy = false;
        match found {
            Ok(Some(backup)) => {
                self.stores.backup.status = BackupStatus::Found {
                    saved_at: backup.saved_at,
                    machines: backup.machines.len() as u32,
                };
                self.stores.backup.found = Some(backup);
            }
            // Nothing there yet: this phone's is the first.
            Ok(None) => {
                self.stores.backup.status = BackupStatus::Idle;
                self.save_backup(true);
            }
            Err(reason) => self.stores.backup.status = BackupStatus::Failed { reason },
        }
        self.state_changed(SliceId::Settings);
    }

    async fn import_backup(&mut self) {
        let Some(backup) = self.stores.backup.found.take() else { return };
        self.stores.backup.status = BackupStatus::Importing;
        let tor_before = self.stores.settings.data.tor_proxy_enabled;
        let stores = &mut self.stores;
        let summary = merge_backup(&backup, &mut stores.machines, &mut stores.settings, &mut stores.quick_prompts);
        log::info!("backup: imported ({} machines added, {} kept)", summary.added, summary.kept);
        for id in [StoreId::Machines, StoreId::Settings, StoreId::QuickPrompts] {
            self.persist_store(id).await;
            self.state_changed(super::slice_of(id));
        }
        self.flush_writes().await;
        let tor = self.stores.settings.data.tor_proxy_enabled;
        if tor != tor_before {
            let proxy = if tor { self.tor_proxy_address.clone() } else { None };
            self.nostr.set_proxy(proxy.clone());
            self.http.set_proxy(proxy.as_deref());
        }
        self.sync_relays();
        self.refresh_authors();
        self.sync_direct_links();
        self.stores.backup.status = BackupStatus::Idle;
        // What the phone has now: the backup, plus anything it kept.
        self.save_backup(false);
    }

    async fn disable_backup(&mut self, delete: bool) {
        abort(&mut self.backup_timer);
        self.stores.backup.found = None;
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

    pub(super) async fn forget_backup_relay(&mut self) {
        self.backup_busy = false;
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

    /// Save the backup now, unless `force` is off and it holds what was last
    /// saved. Never while a found backup waits on the user, or another
    /// operation runs (a change meanwhile arms the next save).
    fn save_backup(&mut self, force: bool) {
        let Some(relay) = self.stores.backup.config.relay.clone() else { return };
        if self.backup_busy || self.stores.backup.found.is_some() {
            return;
        }
        let now = self.clock.now_ms();
        let backup = build_backup(&self.stores.machines, &self.stores.settings.data, &self.stores.quick_prompts.prompts, now);
        let fingerprint = backup_fingerprint(&backup);
        if !force && self.stores.backup.config.fingerprint.as_deref() == Some(fingerprint.as_str()) {
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
                        Ok((now, fingerprint))
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

    pub(super) async fn on_backup_saved(&mut self, saved: Result<(u64, String), String>) {
        self.backup_busy = false;
        match saved {
            Ok((at, fingerprint)) => {
                self.stores.backup.config.saved_at = Some(at);
                self.stores.backup.config.fingerprint = Some(fingerprint);
                self.stores.backup.status = BackupStatus::Idle;
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
    /// the one with the lower id: each one is dated past the last.
    fn next_backup_created_at(&mut self) -> u64 {
        let at = (self.clock.now_ms() / 1000).max(self.backup_created_at + 1);
        self.backup_created_at = at;
        at
    }
}

/// The identity's newest backup on `relay`, once the relay is up.
async fn fetch_event(ws: &WsTransport, relay: &str, me: &str) -> Result<Option<NostrEvent>, String> {
    let deadline = tokio::time::Instant::now() + RELAY_WAIT;
    while !ws.connected_relays().contains(relay) {
        if tokio::time::Instant::now() >= deadline {
            return Err("The backup relay could not be reached.".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let events: Rc<RefCell<Vec<NostrEvent>>> = Rc::default();
    let (done, ended) = oneshot::channel::<()>();
    let done = Rc::new(RefCell::new(Some(done)));
    let collected = Rc::clone(&events);
    let (eose, closed) = (Rc::clone(&done), Rc::clone(&done));
    let sub = ws.subscribe(
        Filter {
            kinds: vec![BACKUP_KIND],
            authors: vec![me.to_string()],
            p_tags: vec![],
            d_tags: vec![backup_d_tag(me)],
            since: None,
        },
        SubCallbacks {
            on_event: Rc::new(move |e: &NostrEvent| collected.borrow_mut().push(e.clone())),
            on_eose: Rc::new(move || {
                if let Some(done) = eose.borrow_mut().take() {
                    let _ = done.send(());
                }
            }),
            on_close: Rc::new(move |_| {
                closed.borrow_mut().take();
            }),
        },
    );
    let answered = tokio::time::timeout(FETCH_BUDGET, ended).await;
    sub.close();
    match answered {
        Ok(Ok(())) => Ok(newest_backup(&events.borrow(), me).cloned()),
        _ => Err("The backup relay did not answer.".into()),
    }
}
