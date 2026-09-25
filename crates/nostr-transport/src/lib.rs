//! CodeDeck+ Nostr relay transport, shared by every runtime that talks to
//! relays — the phone's `client-runtime` today, the bridge's runtime next.
//!
//! - [`port`]: the socket seam (`Transport`, `Filter`, `NostrEvent`) a
//!   runtime's subscription logic is written against, so it can run over the
//!   real driver or a scripted fake.
//! - [`ws`]: `WsTransport`, the real driver — per-relay WebSocket dial
//!   (optionally through a SOCKS5 proxy such as Tor/Orbot), NIP-42 AUTH,
//!   ping/pong liveness, and publish with an honest [`publish`] verdict.
//! - [`frames`] / [`router`]: the pure relay frame codec and the
//!   subscription/publish bookkeeping the driver runs on.
//!
//! Hand-rolled on `tokio-tungstenite` + `tokio-socks` rather than a relay-pool
//! crate — see [`ws`]'s module docs for why.

pub mod frames;
pub mod port;
pub mod publish;
pub mod router;
pub mod ws;

#[cfg(any(test, feature = "mock"))]
pub mod mock;

pub use port::{Filter, NostrEvent, SubCallbacks, Transport, TransportSub};
pub use publish::{classify_publish, combine_publish, PublishResult, PublishVerdict};
pub use ws::{WsConfig, WsTransport};
