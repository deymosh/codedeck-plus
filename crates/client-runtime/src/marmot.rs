//! Marmot (MLS) runtime seam. The MDK engine does ALL the MLS crypto + group
//! state (its own encrypted SQLite store); it lands in this crate as a
//! feature-gated module when `apps/mobile/src-tauri/src/marmot.rs` is
//! relocated. Until then this is the port + a `NoMarmot` stub, plus the
//! transport-side routing the [`crate::core::Core`] does regardless: a kind-444
//! welcome rumor arriving on the 1059 subscription is handed to the engine, and
//! a kind-445 subscription is opened over the joined groups' `h` tags.
//!
//! `client_core::stores::marmot::MarmotState` owns the presentation + the
//! VEIL-029 unjoined buffer; this seam owns the engine calls.

use client_core::stores::marmot::{MarmotGroupInfo, MarmotIngested, MarmotWelcomeInfo};

use crate::ports::LocalBoxFuture;

/// A newly created 1:1 group and the gift-wrapped welcome to publish for the
/// peer.
#[derive(Debug, Clone)]
pub struct MarmotGroupCreated {
    pub group_id: String,
    pub h_tag: String,
    /// The kind-1059 welcome, as a publishable event JSON.
    pub welcome_event: serde_json::Value,
}

/// A group message to publish + the inner rumor id both sides dedup on.
#[derive(Debug, Clone)]
pub struct MarmotOutgoing {
    /// The kind-445 event JSON to publish.
    pub event: serde_json::Value,
    pub rumor_id: String,
    pub created_at: u64,
}

/// The MDK engine behind the platform. Every method may resolve an error
/// string — callers convert failures into logged drops / a bumped `errors`
/// diagnostic, never a throw.
pub trait MarmotEngine {
    /// Idempotent; hands the identity secret to the engine (never logged).
    fn init(&self, secret_hex: &str) -> LocalBoxFuture<'_, Result<String, String>>;
    fn publish_key_package(
        &self,
        relays: &[String],
    ) -> LocalBoxFuture<'_, Result<serde_json::Value, String>>;
    fn create_group(
        &self,
        peer_pubkey: &str,
        peer_key_package: &serde_json::Value,
        relays: &[String],
    ) -> LocalBoxFuture<'_, Result<MarmotGroupCreated, String>>;
    fn send(
        &self,
        group_id: &str,
        text: &str,
    ) -> LocalBoxFuture<'_, Result<MarmotOutgoing, String>>;
    /// Feed one kind-1059 (a 444 welcome) or kind-445 event.
    fn ingest(
        &self,
        event: &serde_json::Value,
    ) -> LocalBoxFuture<'_, Result<MarmotIngested, String>>;
    fn pending_welcomes(&self) -> LocalBoxFuture<'_, Result<Vec<MarmotWelcomeInfo>, String>>;
    fn accept_welcome(
        &self,
        welcome_id: &str,
    ) -> LocalBoxFuture<'_, Result<MarmotGroupInfo, String>>;
    fn list_groups(&self) -> LocalBoxFuture<'_, Result<Vec<MarmotGroupInfo>, String>>;
}

/// The engine absent (plain-browser dev, headless tests, or before the MDK
/// relocation): Marmot chats are unavailable, NIP-17 only. Every call errors.
pub struct NoMarmot;

impl NoMarmot {
    fn unavailable<T>() -> LocalBoxFuture<'static, Result<T, String>> {
        Box::pin(async { Err("Marmot engine unavailable".to_string()) })
    }
}

impl MarmotEngine for NoMarmot {
    fn init(&self, _secret_hex: &str) -> LocalBoxFuture<'_, Result<String, String>> {
        Self::unavailable()
    }
    fn publish_key_package(
        &self,
        _relays: &[String],
    ) -> LocalBoxFuture<'_, Result<serde_json::Value, String>> {
        Self::unavailable()
    }
    fn create_group(
        &self,
        _peer_pubkey: &str,
        _peer_key_package: &serde_json::Value,
        _relays: &[String],
    ) -> LocalBoxFuture<'_, Result<MarmotGroupCreated, String>> {
        Self::unavailable()
    }
    fn send(
        &self,
        _group_id: &str,
        _text: &str,
    ) -> LocalBoxFuture<'_, Result<MarmotOutgoing, String>> {
        Self::unavailable()
    }
    fn ingest(
        &self,
        _event: &serde_json::Value,
    ) -> LocalBoxFuture<'_, Result<MarmotIngested, String>> {
        Self::unavailable()
    }
    fn pending_welcomes(&self) -> LocalBoxFuture<'_, Result<Vec<MarmotWelcomeInfo>, String>> {
        Self::unavailable()
    }
    fn accept_welcome(
        &self,
        _welcome_id: &str,
    ) -> LocalBoxFuture<'_, Result<MarmotGroupInfo, String>> {
        Self::unavailable()
    }
    fn list_groups(&self) -> LocalBoxFuture<'_, Result<Vec<MarmotGroupInfo>, String>> {
        Self::unavailable()
    }
}

// --- the real engine (feature "marmot") ---------------------------------

/// [`MarmotEngine`] over `client_core::marmot_engine::MarmotService` (the
/// relocated MDK 0.8 / MLS + SQLCipher engine). One service behind a
/// `RefCell<Option<_>>`; the runtime is single-threaded so no lock is needed.
/// Async steps (gift wrap / unwrap) clone the `Keys` out first and never hold a
/// borrow across an `.await`.
#[cfg(feature = "marmot")]
pub struct MarmotEngineImpl {
    db_path: std::path::PathBuf,
    svc: std::cell::RefCell<Option<client_core::marmot_engine::MarmotService>>,
}

#[cfg(feature = "marmot")]
impl MarmotEngineImpl {
    pub fn new(db_path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
            svc: std::cell::RefCell::new(None),
        }
    }

    fn keys(&self) -> Result<nostr::Keys, String> {
        self.svc
            .borrow()
            .as_ref()
            .map(|s| s.keys().clone())
            .ok_or_else(|| "marmot not initialized".to_string())
    }
}

#[cfg(feature = "marmot")]
mod convert {
    use super::*;
    use client_core::marmot_engine as eng;

    pub fn group_info(g: eng::GroupInfo) -> MarmotGroupInfo {
        MarmotGroupInfo {
            group_id: g.group_id,
            h_tag: g.h_tag,
            name: g.name,
            members: g.members,
            admins: g.admins,
            active: g.active,
        }
    }

    pub fn welcome_info(w: eng::WelcomeInfo) -> MarmotWelcomeInfo {
        MarmotWelcomeInfo {
            welcome_id: w.welcome_id,
            wrapper_id: w.wrapper_id,
            group_id: w.group_id,
            h_tag: w.h_tag,
            name: w.name,
            welcomer: w.welcomer,
            member_count: u64::from(w.member_count),
        }
    }

    pub fn ingested(i: eng::Ingested) -> MarmotIngested {
        use client_core::stores::marmot::MarmotMessageResult;
        match i {
            eng::Ingested::Welcome {
                welcome_id,
                wrapper_id,
                group_id,
                h_tag,
                name,
                welcomer,
                member_count,
            } => MarmotIngested::Welcome(MarmotWelcomeInfo {
                welcome_id,
                wrapper_id,
                group_id,
                h_tag,
                name,
                welcomer,
                member_count: u64::from(member_count),
            }),
            eng::Ingested::Message {
                group_id,
                id,
                sender,
                kind,
                content,
                created_at,
            } => MarmotIngested::Message(MarmotMessageResult {
                group_id,
                id,
                sender,
                kind: i64::from(kind),
                content,
                created_at,
            }),
            eng::Ingested::NotJoined { h_tag } => MarmotIngested::NotJoined { h_tag },
            eng::Ingested::None => MarmotIngested::None,
            eng::Ingested::Ignored { reason } => MarmotIngested::Ignored { reason },
        }
    }
}

#[cfg(feature = "marmot")]
impl MarmotEngine for MarmotEngineImpl {
    fn init(&self, secret_hex: &str) -> LocalBoxFuture<'_, Result<String, String>> {
        let secret_hex = secret_hex.to_string();
        Box::pin(async move {
            let service =
                client_core::marmot_engine::MarmotService::open(&self.db_path, &secret_hex)?;
            let pubkey = service.pubkey_hex();
            *self.svc.borrow_mut() = Some(service);
            Ok(pubkey)
        })
    }

    fn publish_key_package(
        &self,
        relays: &[String],
    ) -> LocalBoxFuture<'_, Result<serde_json::Value, String>> {
        let relays = relays.to_vec();
        Box::pin(async move {
            let guard = self.svc.borrow();
            let svc = guard.as_ref().ok_or("marmot not initialized")?;
            let event = svc.key_package_event(&relays)?;
            serde_json::to_value(&event).map_err(|e| e.to_string())
        })
    }

    fn create_group(
        &self,
        peer_pubkey: &str,
        peer_key_package: &serde_json::Value,
        relays: &[String],
    ) -> LocalBoxFuture<'_, Result<MarmotGroupCreated, String>> {
        let peer_pubkey = peer_pubkey.to_string();
        let peer_kp = peer_key_package.clone();
        let relays = relays.to_vec();
        Box::pin(async move {
            let peer = nostr::PublicKey::from_hex(&peer_pubkey).map_err(|_| "bad peer pubkey")?;
            let kp_event: nostr::Event =
                serde_json::from_value(peer_kp).map_err(|e| format!("bad key package: {e}"))?;
            let (info, rumor) = {
                let guard = self.svc.borrow();
                let svc = guard.as_ref().ok_or("marmot not initialized")?;
                svc.create_group(&peer, kp_event, &relays)?
            };
            let keys = self.keys()?;
            let wrap = client_core::marmot_engine::gift_wrap_welcome(&keys, &peer, rumor).await?;
            Ok(MarmotGroupCreated {
                group_id: info.group_id,
                h_tag: info.h_tag,
                welcome_event: serde_json::to_value(&wrap).map_err(|e| e.to_string())?,
            })
        })
    }

    fn send(
        &self,
        group_id: &str,
        text: &str,
    ) -> LocalBoxFuture<'_, Result<MarmotOutgoing, String>> {
        let group_id = group_id.to_string();
        let text = text.to_string();
        Box::pin(async move {
            let guard = self.svc.borrow();
            let svc = guard.as_ref().ok_or("marmot not initialized")?;
            let out = svc.send(&group_id, &text)?;
            Ok(MarmotOutgoing {
                event: serde_json::from_str(&out.event_json).map_err(|e| e.to_string())?,
                rumor_id: out.rumor_id,
                created_at: out.created_at,
            })
        })
    }

    fn ingest(
        &self,
        event: &serde_json::Value,
    ) -> LocalBoxFuture<'_, Result<MarmotIngested, String>> {
        let event = event.clone();
        Box::pin(async move {
            let ev: nostr::Event =
                serde_json::from_value(event).map_err(|e| format!("bad event: {e}"))?;
            if ev.kind == nostr::Kind::GiftWrap {
                let keys = self.keys()?;
                let (wrapper_id, rumor) =
                    client_core::marmot_engine::unwrap_welcome(&keys, &ev).await?;
                let guard = self.svc.borrow();
                let svc = guard.as_ref().ok_or("marmot not initialized")?;
                let welcome = svc.process_welcome(&wrapper_id, &rumor)?;
                Ok(MarmotIngested::Welcome(convert::welcome_info(welcome)))
            } else {
                let guard = self.svc.borrow();
                let svc = guard.as_ref().ok_or("marmot not initialized")?;
                Ok(convert::ingested(svc.ingest_group_message(&ev)?))
            }
        })
    }

    fn pending_welcomes(&self) -> LocalBoxFuture<'_, Result<Vec<MarmotWelcomeInfo>, String>> {
        Box::pin(async move {
            let guard = self.svc.borrow();
            let svc = guard.as_ref().ok_or("marmot not initialized")?;
            Ok(svc
                .pending_welcomes()?
                .into_iter()
                .map(convert::welcome_info)
                .collect())
        })
    }

    fn accept_welcome(
        &self,
        welcome_id: &str,
    ) -> LocalBoxFuture<'_, Result<MarmotGroupInfo, String>> {
        let welcome_id = welcome_id.to_string();
        Box::pin(async move {
            let guard = self.svc.borrow();
            let svc = guard.as_ref().ok_or("marmot not initialized")?;
            Ok(convert::group_info(svc.accept_welcome(&welcome_id)?))
        })
    }

    fn list_groups(&self) -> LocalBoxFuture<'_, Result<Vec<MarmotGroupInfo>, String>> {
        Box::pin(async move {
            let guard = self.svc.borrow();
            let svc = guard.as_ref().ok_or("marmot not initialized")?;
            Ok(svc
                .list_groups()?
                .into_iter()
                .map(convert::group_info)
                .collect())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn no_marmot_errors_every_call() {
        let m = NoMarmot;
        assert!(m.init("deadbeef").await.is_err());
        assert!(m.list_groups().await.is_err());
        assert!(m.send("g", "hi").await.is_err());
    }
}
