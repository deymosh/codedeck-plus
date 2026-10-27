//! What goes into the engine ([`Input`]) and what comes out ([`Effect`]).
//!
//! The runtime owns every socket, process and timer. It feeds the engine one
//! input at a time and carries out the effects it returns, in order; results
//! that take time (a git lookup, an HTTP check, a host tool run) come back as
//! further inputs. Nothing here blocks, and nothing here reads a clock the
//! runtime did not provide — the same inputs always give the same effects.

use agent_protocol::{BridgeFrame, HostFrame};
use protocol::commands::UploadFileMsg;
use protocol::common::TerminalEndReason;
use protocol::events::BridgeToPhone;
use serde::{Deserialize, Serialize};

use crate::engine::{PendingDevice, TerminalAllowlist, TerminalAuditRecord};

/// What the allowlist file is told of the devices: the refused ones, and the
/// devices a client of a paired identity still is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalDevices {
    pub pending: Vec<PendingDevice>,
    /// A device is the first key its client granted; once that client is
    /// gone (its key lapsed, it was dropped for a newer one, or its identity
    /// was unpaired) the same phone comes back as a new device, so an
    /// approval of the old one only lingers.
    pub live: std::collections::BTreeSet<String>,
}

/// A command event from a phone, signature already verified. `content` is
/// still NIP-44 ciphertext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundEvent {
    pub id: String,
    /// Author, hex.
    pub pubkey: String,
    /// Seconds since the Unix epoch.
    pub created_at: u64,
    pub content: String,
    /// The event's kind: [`COMMAND_KIND`](protocol::kinds::COMMAND_KIND) for
    /// every command, [`LIVE_KIND`](protocol::kinds::LIVE_KIND) for the
    /// keystrokes a phone types into a terminal. What a command carries is
    /// remembered by its event id so a relay's replay runs nothing twice;
    /// live input must not be (a burst of keystrokes would push command ids
    /// out of the dedup set), so the engine has to tell the two apart before
    /// it accepts either.
    pub kind: u16,
}

/// Which subscription delivered an event, and how it reached the bridge.
/// The terminal audit and `terminal-event` name it, so a person reading them
/// can tell a command that came over a relay from one that came over the
/// bridge's own link — and, of those, one that took the phone through Tor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// The standing subscription over a relay: commands from paired phones.
    Relay,
    /// The standing subscription over the bridge's direct link (LAN, VPN).
    Direct,
    /// The standing subscription over the direct link's `.onion` endpoint
    /// (the phone reached it through Orbot): the same link directly, with Tor
    /// in front, which the audit keeps apart from a plain one.
    Onion,
    /// The pairing window's authorless subscription.
    Pairing,
}

/// A timer the engine asked for; comes back as [`Input::Timer`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TimerId(pub u64);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedPhone {
    pub npub: String,
    pub pubkey_hex: String,
    pub label: String,
    pub paired_at: String,
    /// The identity's clients (phones, desktops), each by the session key it
    /// granted, in the order they first did: every message goes to each of
    /// them (see the engine's `session_keys` module).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clients: Vec<PhoneClient>,
}

/// One client of a paired identity, known by its session key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneClient {
    /// The client's newest key: what its copy of a message is encrypted to.
    pub key: protocol::commands::SessionKeyGrant,
    /// The key it replaced, kept only to read commands still encrypted with
    /// it, until it lapses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<protocol::commands::SessionKeyGrant>,
    /// The device this client is: [`device_id`](protocol::recipients::device_id)
    /// of the FIRST key it granted this bridge, so its name in the terminal
    /// allowlist and in the audit survives every rotation. Empty in a state
    /// file written before devices existed; the engine derives it from the
    /// key there on load.
    #[serde(default)]
    pub device: String,
    /// The client's own name for its device, from its latest grant (a phone
    /// sends its model by default). What the machine's owner reads when
    /// deciding whether to approve a device; never what it trusts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Until when (ms) the client is present: it gets the identity's shared
    /// updates (see `protocol::commands::PresenceMsg`). Not stored: a
    /// restarted bridge counts every client present for a lease, so none
    /// misses what happens before it renews.
    #[serde(skip)]
    pub present_until_ms: u64,
    /// What the client watches for live text. Not stored either: a bridge
    /// that has just restarted does not know, so it sends every session's
    /// live text until the client says again.
    #[serde(skip)]
    pub watch: WatchState,
    /// The terminal whose output the client shows, set the same way `watch`
    /// is: a `presence` says both. A terminal's output goes only to the
    /// clients showing it. Not stored, for the same reason as `watch` — and
    /// because a bridge that has just restarted has no terminals.
    #[serde(skip)]
    pub watch_terminal: WatchState,
}

/// Which session's live text a client wants. Only a `partial` is filtered by
/// it — every other update is not live text and goes to each present client.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum WatchState {
    /// The client has not said yet (or the bridge has just restarted): it
    /// gets every session's live text, the safe default that never leaves a
    /// row frozen on screen.
    #[default]
    Unknown,
    /// It said: `Some(session)` it watches, `None` it watches nothing.
    Watching(Option<String>),
}

impl WatchState {
    /// Whether a `partial` of `session` is this client's.
    pub(crate) fn wants(&self, session: &str) -> bool {
        match self {
            WatchState::Unknown => true,
            WatchState::Watching(watching) => watching.as_deref() == Some(session),
        }
    }

    /// Whether this client shows `term`. Only one that said so does: a
    /// terminal's output is not the completing entry of a row already on
    /// screen, so an unasked client loses nothing by not being sent it — it
    /// draws what it missed with `terminal-replay` from the runtime's ring
    /// when it does attach, and a terminal nobody attached to is one the idle
    /// limit is meant to close.
    pub(crate) fn shows(&self, term: &str) -> bool {
        matches!(self, WatchState::Watching(Some(watching)) if watching == term)
    }
}

/// One copy of a message: for one client of an identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Addressee {
    /// The phone's identity (hex): the event's `p` tag.
    pub phone: String,
    /// The key the payload is NIP-44 encrypted to (hex): the client's
    /// session key, or the identity when it has granted none. The copy's
    /// recipient tag is derived from it (`protocol::recipients`). Inside the
    /// engine only, an empty key stands for every present client of the
    /// identity, until it is addressed.
    pub key: String,
}

impl Addressee {
    /// Every present client of `phone`.
    pub(crate) fn identity(phone: &str) -> Self {
        Self { phone: phone.to_string(), key: String::new() }
    }
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
    /// Boxed: a frame is far larger than every other input.
    HostFrame(Box<HostFrame>),
    /// The agent host process exited (or its pipe broke). Everything it was
    /// doing is gone; the runtime restarts it and sends [`Input::HostUp`].
    HostDown { reason: String },
    Timer(TimerId),
    /// Answer to [`Effect::ReadGitHead`]; `None` when `cwd` is not a repo.
    GitHead { session_id: String, head: Option<String> },
    /// An [`Effect::HandleFileUpload`] finished: the image is on disk and
    /// `text` (the user's words plus its path) is the session's next input.
    FileReady { session_id: String, text: String },
    /// Open a pairing window (replacing an open one).
    OpenPairing { duration_ms: Option<u64> },
    ClosePairing,
    /// The workspace roots or folders changed on disk: republish them.
    WorkspaceChanged,
    /// A shell for [`Effect::TerminalSpawn`] is running; `shell` is what
    /// runs in it. Answer to a `terminal-open`.
    TerminalSpawned { term: String, shell: String },
    /// The shell could not be started (no PTY, no usable program): the open
    /// is answered as a refusal, and `note` is what the audit records.
    TerminalSpawnFailed { term: String, note: String },
    /// A terminal wrote output: `data`, base64, from byte `offset` of
    /// everything it has ever written. Goes to the clients showing it.
    TerminalOutput { term: String, offset: u64, data: String },
    /// A terminal's shell is gone: `code` when it exited on its own, else the
    /// `reason` the runtime saw (its pipe broke, the bridge is going down).
    TerminalExited { term: String, code: Option<i32>, reason: TerminalEndReason },
    /// The terminal allowlist changed on disk — the owner ran
    /// `codedeck-bridge terminal allow|disallow` on the machine: replace what
    /// the engine holds and close the terminals of a device withdrawn.
    TerminalAllowlist(TerminalAllowlist),
    /// The owner unpaired an identity on the machine: it is heard from no
    /// more, and the terminals its devices hold end.
    Unpaired { identity: String },
    /// Stop: end every session, publish the offline heartbeat, then
    /// [`Effect::Stopped`].
    Shutdown,
    /// The web page is showing sign-in `code` to a browser until
    /// `expires_ms`; a paired phone sending it signs that browser in.
    WebSignInPending { code: String, expires_ms: u64 },
    /// The page no longer shows `code`: its browser signed out, or was
    /// dropped to make room, before a phone sent it. A phone sending it now
    /// would be told a browser was let in that is no longer there.
    WebSignInWithdrawn { code: String },
}

#[derive(Debug)]
pub enum Effect {
    /// Publish `message` to each phone in `to`, with the event kind its type
    /// calls for.
    Publish { to: Vec<Addressee>, message: BridgeToPhone },
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
    /// Read `git rev-parse HEAD` in `cwd`; answer with [`Input::GitHead`].
    ReadGitHead { session_id: String, cwd: String },
    /// Fetch / reassemble an uploaded image into the workspace; answer with
    /// [`Input::FileReady`] once it is on disk.
    HandleFileUpload(UploadFileMsg),
    /// Start a shell for `term` in `cwd`, at `cols`×`rows`; answer with
    /// [`Input::TerminalSpawned`] once it runs, or
    /// [`Input::TerminalSpawnFailed`]. The runtime starts it with a built
    /// environment, never the bridge's own: the bridge's may hold the
    /// agents' provider keys.
    TerminalSpawn { term: String, cwd: String, cols: u16, rows: u16 },
    /// Type `bytes` into a terminal, in the order the engine emitted them.
    /// The engine has already checked the sender is the writer and that no
    /// earlier input is missing.
    TerminalWrite { term: String, bytes: Vec<u8> },
    /// The writer's window changed.
    TerminalResize { term: String, cols: u16, rows: u16 },
    /// Send `client` this terminal's output from byte `from`, and what
    /// follows: it attached to a terminal it was not showing.
    TerminalReplay { term: String, from: u64, client: Addressee },
    /// Hang up a terminal: SIGHUP, then kill once it does not go. The engine
    /// has already ended it; this is the shell's part.
    TerminalClose { term: String },
    /// The allowlist's devices changed: write the ones waiting for the
    /// owner's approval where the owner lists them (`codedeck-bridge terminal
    /// pending`), and drop every approved device no client holds any more.
    /// Sent whole, so the file always says what the engine knows.
    TerminalDevices(TerminalDevices),
    /// One line for the terminal audit, in the order the engine decided it.
    /// The engine holds no file: the runtime chains the line to the one
    /// before it and stores it, and denies the audit to no one running as
    /// the bridge's user — the chain catches tampering that is not that
    /// thorough.
    Audit(TerminalAuditRecord),
    /// Shutdown is complete: every publish before this one must still go
    /// out, then the runtime may close the host and the relays.
    Stopped,
    /// A paired phone sent the web page's sign-in `code`: the browser
    /// showing it is signed in, by identity `by` (its npub).
    WebSignedIn { code: String, by: String },
    /// A paired phone asked which browsers are signed in to the web page
    /// (`web-browsers-request`). The engine holds no browser list — the page
    /// does — so the runtime answers `client` from its own `Web` with
    /// `web-browsers`, an empty list when the bridge runs no page.
    WebBrowsers { client: Addressee },
    /// A paired phone ended one signed-in browser (`web-browser-sign-out`) by
    /// the page id `id`. The runtime revokes it and answers the same `client`
    /// with the fresh list, so an id that matches nothing is still answered
    /// with the truth rather than silence.
    WebBrowserSignOut { id: String, client: Addressee },
}

/// Well-known [`Store`](crate::ports::Store) keys.
pub mod store_keys {
    pub const PAIRED_PHONES: &str = "pairedPhones";
    pub const CREDENTIALS: &str = "credentials";
    pub const PROVIDER_PROFILES: &str = "providerProfiles";
    pub const REGISTRY: &str = "registry";
    pub const LAST_SEEN: &str = "lastSeenTimestamp";
    pub const PROCESSED_IDS: &str = "processedEventIds";
    /// The last session list's `rev`, so the next one is greater even if
    /// the clock went back across a restart.
    pub const LIST_REV: &str = "listRev";
    /// Keys whose values contain secrets.
    pub const SECRET_KEYS: [&str; 2] = [CREDENTIALS, PROVIDER_PROFILES];
}
