//! `WsTransport` — the real `nostr_client::Transport` over WebSockets.
//!
//! Hand-rolled on `tokio-tungstenite` (WS) + `tokio-socks` (SOCKS5, for Orbot)
//! rather than a relay-pool crate: the port's whole shape is a thin transport
//! *under* our connection FSM, and `nostr-relay-pool` would re-introduce the
//! very behaviours CDX-020 (self-timed idle close) and CDB-037 (pool fires its
//! own `onclose`) exist to defeat, plus a `publishConfirmed` verdict that
//! collapses `unconfirmed` and `unreachable` — the one distinction CDX-086
//! keeps. The client Nostr wire is ~10 frame shapes ([`frames`]); `nostr` gives
//! event types + signing + NIP-44 + NIP-42, which is all the leverage needed.
//!
//! F1 lands the pure frame codec first ([`frames`]); the socket driver
//! (per-relay connect + read loop, NIP-42 AUTH, ping/pong liveness, publish
//! with the CDX-086 verdict) follows.

pub mod frames;
pub mod router;
pub mod ws;

#[cfg(test)]
pub(crate) mod mock;

pub use ws::{WsConfig, WsTransport};
