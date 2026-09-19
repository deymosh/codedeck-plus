//! THROWAWAY F0 probe-2 — NOT production code.
//!
//! Proves the MDK/MLS + SQLCipher stack from `apps/mobile/src-tauri` survives
//! the plan's re-layout: living in `crates/client-core` as a workspace member +
//! cdylib, alongside the uniffi proc-macro stack, and cross-compiling to
//! `aarch64-linux-android`.

uniffi::setup_scaffolding!();

mod marmot;

pub use marmot::MarmotService;

/// Callable smoke: open two SQLCipher-backed MDK stores under `dir` and run a
/// 1:1 MLS group creation loopback. Proves uniffi + openmls + SQLCipher coexist
/// and the code path actually executes (host only — Android just links this).
#[uniffi::export]
pub fn marmot_loopback_smoke(dir: String) -> Result<String, MarmotProbeError> {
    marmot::loopback(std::path::Path::new(&dir)).map_err(MarmotProbeError::Failed)
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MarmotProbeError {
    #[error("{0}")]
    Failed(String),
}
