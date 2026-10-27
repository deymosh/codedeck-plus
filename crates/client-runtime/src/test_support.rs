//! Shared fixtures for this crate's unit tests: a hydrated store and the
//! phone-side keys, identical wherever a module needs them.

use crate::ports::{MemoryKv, MemoryTranscriptStore};
use crate::signer::PhoneKeys;
use crate::stores::{hydrate, CoreStores, StoresConfig};

pub(crate) async fn stores_with_transcript() -> (CoreStores, MemoryTranscriptStore) {
    let kv = MemoryKv::new();
    let ts = MemoryTranscriptStore::new();
    let h = hydrate(&kv, &ts, &StoresConfig::default()).await;
    (h.stores, ts)
}

pub(crate) async fn stores() -> CoreStores {
    stores_with_transcript().await.0
}

/// Keys for a fresh random identity, with a current session key.
pub(crate) fn phone_keys() -> PhoneKeys {
    let identity = protocol::crypto::generate_keypair();
    let (ring, _) = client_core::stores::session_key::SessionKeyRing::load(None, 1_000);
    PhoneKeys::new(&identity.pubkey_hex, &ring.current, None)
}
