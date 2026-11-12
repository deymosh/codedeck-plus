//! Pairing a phone with a bridge that is already running.
//!
//! A running bridge holds `bridge.lock` and its state, so a second process
//! cannot open a pairing window itself; it asks the running one through two
//! small files in the owner-only home, the way `terminal allow` edits
//! `terminal-allow.json` under a running bridge:
//!
//! - `pairing.json` — written by the bridge whenever a window opens or closes:
//!   the [`Status`] of the current window under its `id`: `open` with the URL
//!   to show, then `paired`, `expired` or `closed`. The last status stays in
//!   the file, so a waiter that looks late still learns how its window ended.
//! - `pair-request` — written by `codedeck-bridge pair` when no window is open
//!   (or the open one is about to expire): the `id` the new window is to have.
//!   The running bridge checks for it every [`WATCH_EVERY`], removes it and
//!   opens that window.
//!
//! So `pair` shows the window that is open, if there is one — a QR someone
//! may be scanning is never replaced under them — and asks for one otherwise;
//! either way it follows that window's `id` until it ends. A starting bridge
//! clears both files, so nothing from an earlier run opens a window or passes
//! for an answer.
//!
//! The home directory is owner-only (0700), so only the bridge's own user can
//! ask for a window — the same guard as the state file's. `pairing.json`
//! carries the pairing URL, which the bridge also prints; it is owner-only
//! too, and its token is good for that one window only.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use bridge_core::{Input, PairedPhone, PairingCloseReason, PairingWindowInfo};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// The request file's name in the bridge home.
pub const REQUEST_FILE: &str = "pair-request";
/// The status file's name in the bridge home.
pub const STATUS_FILE: &str = "pairing.json";
/// How often a running bridge looks for a request: one `metadata` call, so a
/// second is cheap and still feels immediate to someone waiting for a QR.
pub const WATCH_EVERY: Duration = Duration::from_secs(1);
/// How often `pair` reads the status while it waits.
const POLL_EVERY: Duration = Duration::from_millis(250);
/// How long `pair` waits for the running bridge to open its window before it
/// gives up: many times [`WATCH_EVERY`], so only a bridge that does not watch
/// for requests (one started by `pair`, or one older than this command) runs
/// into it.
pub const ANSWER_WITHIN: Duration = Duration::from_secs(10);
/// How long an open window must still have for `pair` to show it rather than
/// ask for a new one: time to get the phone out and scan.
pub const MIN_LEFT: Duration = Duration::from_secs(60);

/// What `pair` writes to ask for a window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    /// The id the window opened for it takes, so `pair` knows its status.
    pub id: String,
}

/// Where a window stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowState {
    Open,
    Paired,
    Expired,
    Closed,
}

/// The phone a window paired, as the operator may see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Phone {
    pub label: String,
    pub npub: String,
}

/// `pairing.json`, and each line `pair --json` prints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The window's id: the one its request named, or a fresh one for a
    /// window the bridge opened on its own.
    pub id: String,
    pub state: WindowState,
    /// The QR content, while the window is open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The URL to show as text, while the window is open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_url: Option<String>,
    /// When an open window expires (ms since the Unix epoch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
    /// The phone that paired, once one has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<Phone>,
}

impl Status {
    /// Whether the window has ended, one way or another.
    pub fn is_final(&self) -> bool {
        self.state != WindowState::Open
    }
}

/// The bridge's side: which request each window answers, and the status file.
pub struct Windows {
    home: PathBuf,
    /// One entry per `Input::OpenPairing` sent, in the order sent: the id a
    /// request named for it, or none for the bridge's own window. The engine
    /// presents windows in the order it is asked for them, so the front entry
    /// is always the window being presented — even when the bridge's own
    /// window and a request are queued in the same moment.
    asked: Rc<RefCell<VecDeque<Option<String>>>>,
    /// The id of the window open now.
    current: Option<String>,
}

impl Windows {
    /// Start with nothing pending: a request or status left by an earlier run
    /// is removed, so it can neither open a window nor pass for an answer.
    pub fn start(home: &Path) -> Self {
        for name in [REQUEST_FILE, STATUS_FILE] {
            let _ = fs::remove_file(home.join(name));
        }
        Self { home: home.to_path_buf(), asked: Rc::default(), current: None }
    }

    /// Ask the engine for the bridge's own window.
    pub fn open(&self, inputs: &mpsc::UnboundedSender<Input>, duration_ms: Option<u64>) {
        ask(&self.asked, inputs, None, duration_ms);
    }

    /// Look for a request every [`WATCH_EVERY`] and open a window for each.
    /// Must be called inside a `LocalSet`. The check is one failed `open`
    /// while nobody asks; the bridge's thread never waits on the disk for it.
    pub fn watch(&self, inputs: mpsc::UnboundedSender<Input>, duration_ms: Option<u64>) {
        let (asked, path) = (Rc::clone(&self.asked), self.home.join(REQUEST_FILE));
        tokio::task::spawn_local(async move {
            let mut ticker = tokio::time::interval(WATCH_EVERY);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if inputs.is_closed() {
                    return;
                }
                if let Some(request) = take_request(&path) {
                    log::info!("[Pairing] Opening a pairing window asked for by `codedeck-bridge pair`");
                    ask(&asked, &inputs, Some(request.id), duration_ms);
                }
            }
        });
    }

    /// The engine presented a window: record it as open.
    pub fn presented(&mut self, info: &PairingWindowInfo) {
        let id = self.asked.borrow_mut().pop_front().flatten().unwrap_or_else(new_id);
        self.current = Some(id.clone());
        self.write(&Status {
            id,
            state: WindowState::Open,
            url: Some(info.url.clone()),
            display_url: Some(info.display_url.clone()),
            expires_at_ms: Some(info.expires_at_ms),
            phone: None,
        });
    }

    /// The engine closed the open window: record how. The URL goes: its token
    /// is dead.
    pub fn closed(&mut self, reason: PairingCloseReason, phone: Option<&PairedPhone>) {
        let state = match reason {
            PairingCloseReason::Paired => WindowState::Paired,
            PairingCloseReason::Expired => WindowState::Expired,
            PairingCloseReason::Closed => WindowState::Closed,
        };
        let id = self.current.take().unwrap_or_default();
        self.write(&Status {
            id,
            state,
            url: None,
            display_url: None,
            expires_at_ms: None,
            phone: phone.map(|p| Phone { label: p.label.clone(), npub: p.npub.clone() }),
        });
    }

    /// Replace the status file. Not synced to disk: it describes a window of
    /// this run only (a starting bridge removes it), and a reader needs the
    /// atomic rename, not durability — so the bridge's thread never waits on
    /// an fsync for it.
    fn write(&self, status: &Status) {
        let path = self.home.join(STATUS_FILE);
        let json = serde_json::to_vec(status).expect("a pairing status serializes");
        if let Err(e) = crate::state::replace_private(&path, &json) {
            log::warn!("[Pairing] cannot write {}: {e}", path.display());
        }
    }
}

/// Queue a window: its id first, then the input, with no await between —
/// the order of `asked` is the order of the inputs.
fn ask(
    asked: &RefCell<VecDeque<Option<String>>>,
    inputs: &mpsc::UnboundedSender<Input>,
    id: Option<String>,
    duration_ms: Option<u64>,
) {
    asked.borrow_mut().push_back(id);
    let _ = inputs.send(Input::OpenPairing { duration_ms });
}

/// The request waiting at `path`, claimed so it is acted on once. Claiming is
/// a rename, which is atomic: a request another `pair` writes a moment later
/// lands as a new file for the next check, instead of being read as gone. A
/// file that is not a request is dropped too, with a warning.
fn take_request(path: &Path) -> Option<Request> {
    let claimed = path.with_extension("claimed");
    match fs::rename(path, &claimed) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!("[Pairing] cannot claim {}: {e}", path.display());
            return None;
        }
    }
    let raw = fs::read(&claimed).unwrap_or_default();
    let _ = fs::remove_file(&claimed);
    match serde_json::from_slice::<Request>(&raw) {
        Ok(request) if !request.id.is_empty() => Some(request),
        _ => {
            log::warn!("[Pairing] {} is not a pairing request; ignored", path.display());
            None
        }
    }
}

/// The status file as it is now; `None` when it is missing or unreadable.
pub fn read_status(home: &Path) -> Option<Status> {
    serde_json::from_slice(&fs::read(home.join(STATUS_FILE)).ok()?).ok()
}

/// A fresh window id.
fn new_id() -> String {
    hex::encode(rand::random::<[u8; 16]>())
}

/// The real clock, in ms since the Unix epoch: what `expiresAtMs` counts in.
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `pair` against a running bridge: show the window open now when it has at
/// least [`MIN_LEFT`] to go, else ask for a new one; call `on_status` with
/// each status of that window as it changes, and return the final one. Ends
/// with an error when the bridge does not answer a request within
/// [`ANSWER_WITHIN`], or stops (`running` turns false) before the window ends.
pub async fn pair(
    home: &Path,
    mut running: impl FnMut() -> bool,
    mut on_status: impl FnMut(&Status),
) -> Result<Status, String> {
    let path = home.join(REQUEST_FILE);
    let usable = read_status(home).filter(|s| {
        s.state == WindowState::Open && s.expires_at_ms.is_some_and(|at| at >= now_ms() + MIN_LEFT.as_millis() as u64)
    });
    // A request already waiting (another `pair` started a moment ago) is
    // followed, not overwritten: both then show the one window it opens.
    let id = match (usable, read_request(&path)) {
        (Some(open), _) => open.id,
        (None, Some(waiting)) => waiting.id,
        (None, None) => {
            let id = new_id();
            let body = serde_json::to_vec(&Request { id: id.clone() }).expect("a pairing request serializes");
            crate::state::write_private(&path, &body).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            id
        }
    };
    let asked_at = tokio::time::Instant::now();
    let mut ticker = tokio::time::interval(POLL_EVERY);
    let mut shown = false;
    loop {
        ticker.tick().await;
        match read_status(home).filter(|s| s.id == id) {
            Some(status) if status.is_final() => {
                on_status(&status);
                return Ok(status);
            }
            Some(status) => {
                if !shown {
                    shown = true;
                    on_status(&status);
                }
            }
            None if shown => {
                return Err("the pairing window is gone: another one replaced it, or the bridge restarted. Run \
                            `codedeck-bridge pair` again."
                    .into());
            }
            // Also when following an open window whose status vanished
            // before it was shown: never a wait without an end.
            None if asked_at.elapsed() >= ANSWER_WITHIN => {
                withdraw(&path, &id);
                return Err(format!(
                    "the running bridge did not answer within {} s. A bridge started with `pair`, or one older than \
                     this command, cannot open a window for another process: stop it and run `codedeck-bridge pair`.",
                    ANSWER_WITHIN.as_secs()
                ));
            }
            None => {}
        }
        if !running() {
            withdraw(&path, &id);
            return Err("the bridge stopped before the pairing window ended".into());
        }
    }
}

/// The request waiting at `path`, if any.
fn read_request(path: &Path) -> Option<Request> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Remove our request if it is still waiting, so no bridge acts on it later.
fn withdraw(path: &Path, id: &str) {
    if read_request(path).is_some_and(|r| r.id == id) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tokio::task::LocalSet;

    fn info(token: &str) -> PairingWindowInfo {
        PairingWindowInfo {
            url: format!("nostr+codedeck://pair?token={token}"),
            display_url: format!("nostr+codedeck://pair?token={token}"),
            token: token.to_string(),
            expires_at_ms: 1_700_000_600_000,
        }
    }

    /// A window that expires `left` from now on the real clock, which is the
    /// one `pair` judges an open window by.
    fn info_left(token: &str, left: Duration) -> PairingWindowInfo {
        PairingWindowInfo { expires_at_ms: now_ms() + left.as_millis() as u64, ..info(token) }
    }

    fn phone() -> PairedPhone {
        PairedPhone {
            npub: "npub1phone".into(),
            pubkey_hex: "ab".repeat(32),
            label: "Pixel 8".into(),
            paired_at: "2026-11-12T00:00:00Z".into(),
            clients: Vec::new(),
        }
    }

    /// The next input the bridge's loop would get, asserting it is a request
    /// for a window.
    async fn next_open(rx: &mut mpsc::UnboundedReceiver<Input>) {
        match rx.recv().await {
            Some(Input::OpenPairing { .. }) => {}
            other => panic!("expected OpenPairing, got {other:?}"),
        }
    }

    /// The whole exchange: `pair` asks, the bridge's watcher hears it within
    /// a tick, the window it opens is the one `pair` shows, and `pair` ends
    /// when the phone pairs.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_request_opens_a_window_that_pair_follows_until_a_phone_pairs() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        LocalSet::new()
            .run_until(async move {
                let mut windows = Windows::start(&home);
                let (inputs, mut rx) = mpsc::unbounded_channel();
                windows.watch(inputs, None);

                let seen = Rc::new(RefCell::new(Vec::new()));
                let client = tokio::task::spawn_local({
                    let (home, seen) = (home.clone(), Rc::clone(&seen));
                    async move { pair(&home, || true, |s| seen.borrow_mut().push(s.clone())).await }
                });

                next_open(&mut rx).await;
                assert!(!home.join(REQUEST_FILE).exists(), "the bridge consumes the request");
                windows.presented(&info("tok1"));
                tokio::time::sleep(POLL_EVERY * 2).await;
                {
                    let seen = seen.borrow();
                    assert_eq!(seen.len(), 1, "pair shows the open window once: {seen:?}");
                    assert_eq!(seen[0].state, WindowState::Open);
                    assert_eq!(seen[0].url.as_deref(), Some("nostr+codedeck://pair?token=tok1"));
                    assert_eq!(seen[0].expires_at_ms, Some(1_700_000_600_000));
                }

                windows.closed(PairingCloseReason::Paired, Some(&phone()));
                let last = client.await.unwrap().expect("pair ends with the outcome");
                assert_eq!(last.state, WindowState::Paired);
                assert_eq!(last.phone, Some(Phone { label: "Pixel 8".into(), npub: "npub1phone".into() }));
                assert!(last.url.is_none(), "a closed window's URL is not kept");
                assert_eq!(seen.borrow().last(), Some(&last));
            })
            .await;
    }

    /// The bridge's own window and a request queued in the same moment: the
    /// request is matched to the window opened for it, not to the bridge's
    /// own one that it replaces, so `pair` is not told "closed" for a window
    /// it never asked for.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_request_queued_behind_the_bridges_own_window_gets_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        LocalSet::new()
            .run_until(async move {
                let mut windows = Windows::start(&home);
                let (inputs, mut rx) = mpsc::unbounded_channel();
                windows.watch(inputs.clone(), None);
                let client = tokio::task::spawn_local({
                    let home = home.clone();
                    async move { pair(&home, || true, |_| {}).await }
                });
                // The bridge's own window (an expired one being renewed) is
                // asked for first; the request arrives right behind it.
                windows.open(&inputs, None);
                next_open(&mut rx).await;
                next_open(&mut rx).await;

                // The engine presents them in order; the second replaces the
                // first, closing it.
                windows.presented(&info("own"));
                let own = read_status(&home).unwrap();
                assert!(!own.id.is_empty(), "the bridge's own window has an id too");
                windows.closed(PairingCloseReason::Closed, None);
                windows.presented(&info("asked"));
                tokio::time::sleep(POLL_EVERY * 2).await;
                assert!(!client.is_finished(), "pair keeps waiting on its own window");

                windows.closed(PairingCloseReason::Expired, None);
                let last = client.await.unwrap().unwrap();
                assert_eq!(last.state, WindowState::Expired);
            })
            .await;
    }

    /// A window already open is the one `pair` shows: asking for a new one
    /// would kill the QR someone may be scanning.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn an_open_window_is_shown_not_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        LocalSet::new()
            .run_until(async move {
                let mut windows = Windows::start(&home);
                let (inputs, mut rx) = mpsc::unbounded_channel();
                windows.watch(inputs.clone(), None);
                windows.open(&inputs, None);
                next_open(&mut rx).await;
                windows.presented(&info_left("own", Duration::from_secs(300)));

                let seen = Rc::new(RefCell::new(Vec::new()));
                let client = tokio::task::spawn_local({
                    let (home, seen) = (home.clone(), Rc::clone(&seen));
                    async move { pair(&home, || true, |s| seen.borrow_mut().push(s.clone())).await }
                });
                tokio::time::sleep(WATCH_EVERY * 3).await;
                assert!(rx.try_recv().is_err(), "no new window is asked for");
                assert!(!home.join(REQUEST_FILE).exists());
                assert_eq!(seen.borrow()[0].url.as_deref(), Some("nostr+codedeck://pair?token=own"));

                windows.closed(PairingCloseReason::Paired, Some(&phone()));
                assert_eq!(client.await.unwrap().unwrap().state, WindowState::Paired);
            })
            .await;
    }

    /// An open window about to expire is not worth showing: there is no time
    /// left to scan it, so `pair` asks for a fresh one.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_window_about_to_expire_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        LocalSet::new()
            .run_until(async move {
                let mut windows = Windows::start(&home);
                let (inputs, mut rx) = mpsc::unbounded_channel();
                windows.watch(inputs.clone(), None);
                windows.open(&inputs, None);
                next_open(&mut rx).await;
                windows.presented(&info_left("old", MIN_LEFT / 2));

                let client = tokio::task::spawn_local({
                    let home = home.clone();
                    async move { pair(&home, || true, |_| {}).await }
                });
                next_open(&mut rx).await;
                windows.closed(PairingCloseReason::Closed, None);
                windows.presented(&info_left("new", Duration::from_secs(600)));
                tokio::time::sleep(POLL_EVERY * 2).await;
                assert!(!client.is_finished(), "the old window's close is not pair's");
                windows.closed(PairingCloseReason::Expired, None);
                assert_eq!(client.await.unwrap().unwrap().state, WindowState::Expired);
            })
            .await;
    }

    /// Two `pair`s started together with no window open: the second follows
    /// the request already waiting instead of overwriting it, so both show
    /// the one window and neither is told the bridge did not answer.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_second_pair_follows_the_request_already_waiting() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        LocalSet::new()
            .run_until(async move {
                let mut windows = Windows::start(&home);
                let spawn = |home: PathBuf| tokio::task::spawn_local(async move { pair(&home, || true, |_| {}).await });
                let first = spawn(home.clone());
                tokio::time::sleep(POLL_EVERY).await;
                assert!(home.join(REQUEST_FILE).exists(), "the first pair asked");
                let second = spawn(home.clone());
                tokio::time::sleep(POLL_EVERY).await;

                // The bridge only now looks: one request, one window.
                let (inputs, mut rx) = mpsc::unbounded_channel();
                windows.watch(inputs, None);
                next_open(&mut rx).await;
                windows.presented(&info("one"));
                tokio::time::sleep(WATCH_EVERY * 2).await;
                assert!(rx.try_recv().is_err(), "a single window for both");

                windows.closed(PairingCloseReason::Paired, Some(&phone()));
                assert_eq!(first.await.unwrap().unwrap().state, WindowState::Paired);
                assert_eq!(second.await.unwrap().unwrap().state, WindowState::Paired);
            })
            .await;
    }

    /// A bridge that never answers — started by `pair`, or older than this
    /// command — leaves `pair` with an error, not a wait forever, and the
    /// request is withdrawn so no later bridge acts on it.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn pair_gives_up_on_a_bridge_that_does_not_answer() {
        let dir = tempfile::tempdir().unwrap();
        let started = tokio::time::Instant::now();
        let err = pair(dir.path(), || true, |_| {}).await.unwrap_err();
        assert!(err.contains("did not answer"), "{err}");
        assert!(started.elapsed() >= ANSWER_WITHIN);
        assert!(!dir.path().join(REQUEST_FILE).exists(), "the request is withdrawn");
    }

    /// The bridge stops while `pair` waits on an open window: `pair` says so
    /// instead of waiting for an outcome that will never be written.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn pair_stops_waiting_when_the_bridge_stops() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        LocalSet::new()
            .run_until(async move {
                let mut windows = Windows::start(&home);
                let (inputs, mut rx) = mpsc::unbounded_channel();
                windows.watch(inputs, None);
                let alive = Rc::new(RefCell::new(true));
                let client = tokio::task::spawn_local({
                    let (home, alive) = (home.clone(), Rc::clone(&alive));
                    async move { pair(&home, move || *alive.borrow(), |_| {}).await }
                });
                next_open(&mut rx).await;
                windows.presented(&info("tok"));
                tokio::time::sleep(POLL_EVERY * 2).await;
                *alive.borrow_mut() = false;
                let err = client.await.unwrap().unwrap_err();
                assert!(err.contains("stopped"), "{err}");
            })
            .await;
    }

    /// A request or status left by an earlier run neither opens a window nor
    /// passes for an answer: a starting bridge clears both.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_starting_bridge_ignores_what_an_earlier_run_left() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        fs::write(home.join(REQUEST_FILE), r#"{"id":"old"}"#).unwrap();
        fs::write(home.join(STATUS_FILE), r#"{"id":"old","state":"open","url":"x"}"#).unwrap();
        LocalSet::new()
            .run_until(async move {
                let windows = Windows::start(&home);
                assert!(read_status(&home).is_none());
                let (inputs, mut rx) = mpsc::unbounded_channel();
                windows.watch(inputs, None);
                tokio::time::sleep(WATCH_EVERY * 3).await;
                assert!(rx.try_recv().is_err(), "no window for an old request");
            })
            .await;
    }

    /// A request file that is not a request (an editor's leftover, a torn
    /// write) is dropped with a warning; the watcher keeps going.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_malformed_request_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        LocalSet::new()
            .run_until(async move {
                let windows = Windows::start(&home);
                let (inputs, mut rx) = mpsc::unbounded_channel();
                windows.watch(inputs, None);
                fs::write(home.join(REQUEST_FILE), "{torn").unwrap();
                tokio::time::sleep(WATCH_EVERY * 2).await;
                assert!(rx.try_recv().is_err());
                assert!(!home.join(REQUEST_FILE).exists());
            })
            .await;
    }

    #[cfg(unix)]
    #[test]
    fn the_status_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mut windows = Windows::start(dir.path());
        windows.asked.borrow_mut().push_back(None);
        windows.presented(&info("tok"));
        let mode = fs::metadata(dir.path().join(STATUS_FILE)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
