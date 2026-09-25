//! What goes into the engine ([`Input`]) and what comes out ([`Effect`]).
//!
//! The runtime owns every socket, process and timer. It feeds the engine one
//! input at a time and carries out the effects it returns, in order; results
//! that take time (a git lookup, an HTTP check, a host tool run) come back as
//! further inputs. Nothing here blocks, and nothing here reads a clock the
//! runtime did not provide — the same inputs always give the same effects.

use agent_protocol::{BridgeFrame, HostFrame, Secret};
use protocol::commands::UploadImageMsg;
use protocol::common::{DeviceConfig, GsdState, OutputEntry};
use protocol::events::BridgeToPhone;
use serde::{Deserialize, Serialize};

/// A command event from the relays, signature already verified. `content` is
/// still NIP-44 ciphertext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundEvent {
    pub id: String,
    /// Author, hex.
    pub pubkey: String,
    /// Seconds since the Unix epoch.
    pub created_at: u64,
    pub content: String,
}

/// Which subscription delivered an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// The standing subscription: commands from paired phones.
    Commands,
    /// The pairing window's authorless subscription.
    Pairing,
}

/// A timer the engine asked for; comes back as [`Input::Timer`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TimerId(pub u64);

/// The mesh network a pairing QR should also let the phone join.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshJoin {
    /// This machine's mesh admin device id (an npub).
    pub admin_device_id: String,
    pub netid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedPhone {
    pub npub: String,
    pub pubkey_hex: String,
    pub label: String,
    pub paired_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingCloseReason {
    Paired,
    Expired,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingWindowInfo {
    /// The QR content.
    pub url: String,
    /// Safe to show as text.
    pub display_url: String,
    pub token: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyLevel {
    Info,
    Warn,
}

#[derive(Debug)]
pub enum Input {
    /// Always the first input: load persisted state, arm the periodic
    /// timers, publish the first heartbeat. Sessions in the registry come
    /// back once the agent host is up.
    Start,
    RelayEvent { event: InboundEvent, via: Via },
    /// The agent host process is running and reading frames.
    HostUp,
    HostFrame(HostFrame),
    /// The agent host process exited (or its pipe broke). Everything it was
    /// doing is gone; the runtime restarts it and sends [`Input::HostUp`].
    HostDown { reason: String },
    Timer(TimerId),
    /// Answer to [`Effect::ReadGitHead`]; `None` when `cwd` is not a repo.
    GitHead { session_id: String, head: Option<String> },
    /// Answer to [`Effect::ReadGsd`].
    Gsd { session_id: String, gsd: GsdState },
    /// Answer to [`Effect::RunHostTool`].
    HostToolDone { call_id: String, text: String, is_error: bool },
    /// Answer to [`Effect::CheckProviderToken`]; `None` when it could not be
    /// checked (network error).
    ProviderTokenChecked { ticket: u64, valid: Option<bool> },
    /// Answer to [`Effect::ApplyDeviceConfig`].
    DeviceConfigApplied { phone: String, result: Result<(), String> },
    /// An [`Effect::HandleImageUpload`] finished: the image is on disk and
    /// `text` (the user's words plus its path) is the session's next input.
    ImageReady { session_id: String, text: String },
    /// An entry the runtime produced for a session (a device screenshot).
    SessionEntry { session_id: String, entry: OutputEntry },
    /// Open a pairing window (replacing an open one).
    OpenPairing { duration_ms: Option<u64>, mesh: Option<MeshJoin> },
    ClosePairing,
    /// The workspace roots or folders changed on disk: republish them.
    WorkspaceChanged,
    /// Stop: end every session, publish the offline heartbeat, then
    /// [`Effect::Stopped`].
    Shutdown,
}

#[derive(Debug)]
pub enum Effect {
    /// Encrypt `message` to each phone in `to` (hex pubkeys) and publish it
    /// with the event kind its type calls for.
    Publish { to: Vec<String>, message: BridgeToPhone },
    /// Write one frame to the agent host's stdin.
    Host(BridgeFrame),
    SetTimer { id: TimerId, after_ms: u64 },
    CancelTimer(TimerId),
    /// The paired phones changed: rebuild the command subscription from
    /// [`Engine::commands_filter`](crate::Engine::commands_filter).
    Resubscribe,
    /// Open the pairing window's subscription: command events tagged to the
    /// bridge from ANY author, created at or after `since` (seconds). Keep
    /// it open until [`Effect::ClosePairingSubscription`], re-subscribing if
    /// the relays drop it.
    OpenPairingSubscription { since: u64 },
    ClosePairingSubscription,
    /// Show the pairing QR to the operator.
    PresentPairing(PairingWindowInfo),
    /// The pairing window closed; `phone` is set when it closed because a
    /// phone paired.
    PairingClosed { reason: PairingCloseReason, phone: Option<PairedPhone> },
    /// Tell the operator something (desktop notification / log line).
    Notify { level: NotifyLevel, text: String },
    /// Register a freshly paired phone with services that gate on pubkey (a
    /// write-restricted relay, the image server). Best effort; a failure is
    /// the runtime's to report.
    RegisterPhone { pubkey_hex: String, label: String },
    /// Read `git rev-parse HEAD` in `cwd`; answer with [`Input::GitHead`].
    ReadGitHead { session_id: String, cwd: String },
    /// Read the GSD workflow state of `cwd`; answer with [`Input::Gsd`].
    ReadGsd { session_id: String, cwd: String },
    /// Run one of the session's host tools; answer with
    /// [`Input::HostToolDone`] carrying `call_id`.
    RunHostTool {
        call_id: String,
        session_id: String,
        tool: String,
        args: serde_json::Value,
    },
    /// Check a provider token with a one-token request to
    /// `{base_url}/v1/messages` for `model`; answer with
    /// [`Input::ProviderTokenChecked`]. `base_url` has passed the https rule.
    CheckProviderToken {
        ticket: u64,
        base_url: String,
        token: Secret,
        model: String,
    },
    /// Persist a phone's device config and do its mesh onboarding; answer
    /// with [`Input::DeviceConfigApplied`].
    ApplyDeviceConfig { phone: String, config: DeviceConfig },
    /// Fetch / reassemble an uploaded image into the workspace; answer with
    /// [`Input::ImageReady`] once it is on disk.
    HandleImageUpload(UploadImageMsg),
    /// Shutdown is complete: every publish before this one must still go
    /// out, then the runtime may close the host and the relays.
    Stopped,
}

/// Well-known [`Store`](crate::ports::Store) keys.
pub mod store_keys {
    pub const PAIRED_PHONES: &str = "pairedPhones";
    pub const CREDENTIALS: &str = "credentials";
    pub const PROVIDER_PROFILES: &str = "providerProfiles";
    pub const REGISTRY: &str = "registry";
    pub const LAST_SEEN: &str = "lastSeenTimestamp";
    pub const PROCESSED_IDS: &str = "processedEventIds";
    /// Keys whose values contain secrets.
    pub const SECRET_KEYS: [&str; 2] = [CREDENTIALS, PROVIDER_PROFILES];
}
