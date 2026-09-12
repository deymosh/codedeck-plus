//! THROWAWAY F0 spike — NOT production code.
//!
//! Answers migration plan §7 F0-probe-1 with running code: is a UniFFI-generated
//! API for the future Rust `client-core` ergonomic from Kotlin/Compose and
//! reasonable from Tauri? It deliberately exercises the five things that would
//! sink the whole approach if UniFFI handled them badly:
//!
//!   1. a foreign-implemented callback trait  (`CoreListener`)
//!   2. an `async fn` command                 (`Core::dispatch` -> Kotlin `suspend fun`)
//!   3. a typed error across the boundary     (`CoreError` / `CryptoError`)
//!   4. object lifecycle with a bg task       (`start` / `stop`, no thread leak)
//!   5. concurrency                           (dispatch storm while the bg task emits)
//!
//! Plus real NIP-44 v2 crossing the FFI as plain `String`, to size the
//! dependency footprint of leaning on the `nostr` crate (plan risk #13).
//!
//! Delete this whole `spike/` tree once `spike/uniffi-binding-probe/README.md`
//! records the Go/No-Go.

uniffi::setup_scaffolding!();

mod core;
mod crypto;

pub use core::{Core, CoreError, CoreEvent, CoreListener, Intent, ProbeView};
pub use crypto::{decrypt_from, encrypt_to, generate_keypair, keypair_from_secret, CryptoError, Keypair};
