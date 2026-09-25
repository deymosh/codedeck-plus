//! Routes the `log` crate to `adb logcat` under the tag `codedeck`, and turns
//! a Rust panic anywhere in the core thread into a logged error instead of a
//! silent death.
//!
//! Every `client_runtime`/`client_core` call site logs through the plain
//! `log` facade (`log::info!`, `log::warn!`, …) so the same instrumentation
//! also works for `apps/mobile/src-tauri` the day it wires its own backend —
//! this module is the ONLY Android-specific piece: it just decides where
//! those records go.
//!
//! Without this, `Core::new`'s dedicated OS thread has no logging backend at
//! all, and — unlike a typical Linux process — Zygote dups this app's own
//! stdout/stderr to `/dev/null` (verified via `/proc/<pid>/fd/{1,2}` on a
//! debug build), so a bare `eprintln!`/default panic hook is provably
//! invisible in `adb logcat`. `android_logger` installs the `log` backend;
//! `log_panics` gives panics the same treatment `RUST_BACKTRACE=1` gives a
//! desktop binary, just aimed at logcat instead of stderr.

use std::sync::Once;

static INIT: Once = Once::new();

/// Idempotent — call from every `Core::new`, not just the first. Filter
/// level: `debug` for this crate's own tag and `client_runtime`/`client_core`
/// (the connection FSM and transport are what a report like "never connects"
/// needs); everything else stays at `info` so a chatty dependency can't drown
/// the signal.
pub fn install() {
    INIT.call_once(|| {
        #[cfg(target_os = "android")]
        {
            android_logger::init_once(
                android_logger::Config::default()
                    .with_max_level(log::LevelFilter::Debug)
                    .with_tag("codedeck"),
            );
            log_panics::init();
        }
        #[cfg(not(target_os = "android"))]
        {
            // Non-Android test/host builds: a plain env_logger is enough to
            // exercise the same log:: call sites during `cargo test` with
            // `RUST_LOG=debug`, and costs nothing when no test sets that var.
            let _ = env_logger::try_init();
        }
        log::info!("android_log: logging backend installed (tag=\"codedeck\")");
    });
}
