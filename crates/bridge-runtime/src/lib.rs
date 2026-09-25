//! The bridge binary's runtime: everything around the `bridge-core` engine
//! that touches the outside world — relays (over Tor when configured), the
//! agent host process, the state file and transcripts on disk, the workspace
//! directories, timers, signals and the command line.
//!
//! The engine decides; this crate only carries out its effects and feeds it
//! what happened.

pub mod config;
pub mod devices;
pub mod gsd;
pub mod host;
pub mod images;
pub mod mesh;
pub mod qr;
pub mod relay;
pub mod runtime;
pub mod state;
pub mod transcripts;
pub mod work;
pub mod workspace;

/// The bridge's version: the release number stamped at build time
/// (`CODEDECK_VERSION`), else the crate version.
pub fn version() -> &'static str {
    match option_env!("CODEDECK_VERSION") {
        Some(v) if !v.is_empty() => v,
        _ => env!("CARGO_PKG_VERSION"),
    }
}
