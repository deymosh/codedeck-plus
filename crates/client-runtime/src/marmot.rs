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
