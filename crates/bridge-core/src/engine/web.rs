//! Browser sign-in for the bridge's web page.
//!
//! The page shows a short code to a browser that asks to sign in, and tells
//! the engine ([`Input::WebSignInPending`]); a paired phone sends that code
//! (`web-sign-in`), and the engine — which already knows the command came
//! from a paired identity — matches it and lets that browser in
//! ([`Effect::WebSignedIn`]). A code works once, and only until it lapses:
//! anyone who reads it off the screen still needs a paired phone to use it.

use std::collections::{BTreeMap, HashMap};

use protocol::commands::{PhoneToBridge, UploadFileMsg};
use protocol::common::TerminalVia;
use protocol::events::{BridgeToPhone, WebSignInResultMsg};

use super::Engine;
use crate::io::{Addressee, Effect, WatchState};

/// Whether a browser may send `msg`. A browser drives sessions, reads, and
/// attaches files; what belongs to an identity (its keys, letting in another
/// browser, pairing), what moves a secret or a sign-in, the terminal (whose
/// allowlist names devices, and a browser is none) and the agents'
/// configuration stay with the phone. Every command is named, so a new one
/// is decided here rather than let through by default.
///
/// A file comes only in chunks, on the signed stream itself. The Blossom
/// form names a URL for the bridge to download, through the Tor proxy when
/// one is set; a browser has no Blossom server of its own, and taking one
/// would let a page make the bridge fetch whatever URL it names.
pub fn browser_may_send(msg: &PhoneToBridge) -> bool {
    match msg {
        PhoneToBridge::UploadFile(UploadFileMsg::Chunk(_)) => true,
        PhoneToBridge::UploadFile(UploadFileMsg::Blossom(_)) => false,
        PhoneToBridge::Input(_)
        | PhoneToBridge::PermissionResponse(_)
        | PhoneToBridge::QuestionResponse(_)
        | PhoneToBridge::PlanResponse(_)
        | PhoneToBridge::SetOption(_)
        | PhoneToBridge::SyncRequest(_)
        | PhoneToBridge::SyncAck(_)
        | PhoneToBridge::CreateSession(_)
        | PhoneToBridge::RefreshSessions(_)
        | PhoneToBridge::CloseSession(_)
        | PhoneToBridge::Interrupt(_)
        | PhoneToBridge::StopTask(_)
        | PhoneToBridge::CreateFolder(_)
        | PhoneToBridge::Presence(_)
        | PhoneToBridge::UsageRequest(_)
        | PhoneToBridge::ModelsRequest(_)
        | PhoneToBridge::AgentStyleRequest(_)
        | PhoneToBridge::CommandsRequest(_)
        | PhoneToBridge::PersonasRequest(_)
        | PhoneToBridge::PluginsRequest(_)
        | PhoneToBridge::McpRequest(_)
        | PhoneToBridge::SessionMcpRequest(_)
        | PhoneToBridge::PermissionRulesRequest(_)
        | PhoneToBridge::AccountsRequest(_)
        | PhoneToBridge::ProviderProfilesRequest(_)
        | PhoneToBridge::WebBrowsersRequest(_)
        | PhoneToBridge::WebBrowserSignOut(_) => true,
        PhoneToBridge::SessionKey(_)
        | PhoneToBridge::PairRequest(_)
        | PhoneToBridge::WebSignIn(_)
        | PhoneToBridge::SetCredentials(_)
        | PhoneToBridge::SetProviderProfile(_)
        | PhoneToBridge::AccountAction(_)
        | PhoneToBridge::TerminalOpen(_)
        | PhoneToBridge::TerminalInput(_)
        | PhoneToBridge::TerminalResize(_)
        | PhoneToBridge::TerminalReplay(_)
        | PhoneToBridge::TerminalTakeover(_)
        | PhoneToBridge::TerminalClose(_)
        | PhoneToBridge::PluginAction(_)
        | PhoneToBridge::McpAction(_)
        | PhoneToBridge::AgentAction(_)
        | PhoneToBridge::SessionMcpToggle(_)
        | PhoneToBridge::PermissionRulesRemove(_) => false,
    }
}

/// A browser with a stream open: a present client of the identity that let
/// it in. One whose streams all closed is not kept — it gets nothing until it
/// opens one, and says again what it watches.
#[derive(Debug)]
pub(super) struct BrowserClient {
    /// The identity that let it in (hex).
    identity: String,
    /// Which session's live text it wants.
    watch: WatchState,
}

/// The browsers with a stream open, by their public id.
pub(super) type Browsers = BTreeMap<String, BrowserClient>;

/// Codes the page is showing at once; the soonest to lapse goes first past
/// it. The page caps its own pending sign-ins at this too, and withdraws a
/// code it stops showing ([`crate::Input::WebSignInWithdrawn`]), so the two sets
/// stay the same.
pub const MAX_WEB_SIGN_IN_CODES: usize = 64;

/// The codes the web page is showing, with when each lapses (ms).
#[derive(Debug, Default)]
pub(super) struct WebSignIns {
    codes: HashMap<String, u64>,
}

/// A code as a phone may type it: any case, the dash optional, spaces
/// around it ignored.
fn normalize(code: &str) -> String {
    let compact: String = code.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect();
    if compact.len() == 8 {
        format!("{}-{}", &compact[..4], &compact[4..])
    } else {
        compact
    }
}

impl Engine {
    /// The web page is showing `code` until `expires_ms`.
    pub(super) fn on_web_sign_in_pending(&mut self, code: String, expires_ms: u64) {
        let now = self.now();
        let codes = &mut self.web_sign_ins.codes;
        codes.retain(|_, expires| *expires > now);
        while codes.len() >= MAX_WEB_SIGN_IN_CODES {
            let Some(soonest) = codes.iter().min_by_key(|(_, e)| **e).map(|(c, _)| c.clone()) else { break };
            codes.remove(&soonest);
        }
        codes.insert(normalize(&code), expires_ms);
    }

    /// The page stopped showing `code`: no phone may use it any more.
    pub(super) fn on_web_sign_in_withdrawn(&mut self, code: &str) {
        self.web_sign_ins.codes.remove(&normalize(code));
    }

    /// A paired phone sent `code`: sign in the browser showing it, once. The
    /// answer echoes the code exactly as the phone sent it, so the phone can
    /// match it to the attempt it is showing however the user typed it.
    pub(super) fn on_web_sign_in(&mut self, sent: &str, phone: &str) {
        let code = normalize(sent);
        let now = self.now();
        let live = self.web_sign_ins.codes.remove(&code).is_some_and(|expires| expires > now);
        if live {
            let by = self.paired.iter().find(|p| p.pubkey_hex == phone).map(|p| p.npub.clone()).unwrap_or_else(|| phone.to_string());
            log::info!("[Engine] A browser was signed in to the web page");
            self.out.push(Effect::WebSignedIn { code: code.clone(), by });
        } else {
            log::info!("[Engine] A web sign-in code did not match");
        }
        self.publish_to(phone, BridgeToPhone::WebSignInResult(WebSignInResultMsg { code: sent.to_string(), signed_in: live }));
    }

    /// A paired phone asked which browsers are signed in to the page. The
    /// engine holds no browser list — the page does — so this is an effect the
    /// runtime answers from its own `Web`, to the client that asked alone.
    pub(super) fn on_web_browsers_request(&mut self) {
        if let Some(client) = self.requester.clone() {
            self.out.push(Effect::WebBrowsers { client });
        }
    }

    /// A paired phone ended one signed-in browser by the page id it saw. The
    /// engine does not know the browser either, so the runtime revokes it and
    /// answers the same client with the fresh list.
    pub(super) fn on_web_browser_sign_out(&mut self, id: String) {
        if let Some(client) = self.requester.clone() {
            self.out.push(Effect::WebBrowserSignOut { id, client });
        }
    }

    /// The paired identity whose npub is `by`, as hex.
    fn identity_of_npub(&self, by: &str) -> Option<String> {
        self.paired.iter().find(|p| p.npub == by).map(|p| p.pubkey_hex.clone())
    }

    /// A browser that `by` let in opened its first stream. An identity that
    /// is no longer paired lets nothing in: its browsers are ended.
    pub(super) fn on_web_browser_online(&mut self, id: String, by: &str) {
        let Some(identity) = self.identity_of_npub(by) else {
            self.out.push(Effect::WebEndBrowsers { by: by.to_string() });
            return;
        };
        self.browser_present(&id, &identity);
    }

    /// `id` is a present client of `identity`; one that was not gets a
    /// heartbeat of its own, as a phone's client back from away does.
    fn browser_present(&mut self, id: &str, identity: &str) {
        if self.browsers.contains_key(id) {
            return;
        }
        log::info!("[Engine] A browser of {}... is online", identity.get(..8).unwrap_or(identity));
        self.want_list(Addressee::browser(identity, id));
        self.browsers.insert(id.to_string(), BrowserClient { identity: identity.to_string(), watch: WatchState::Unknown });
    }

    pub(super) fn on_web_browser_offline(&mut self, id: &str) {
        self.browsers.remove(id);
    }

    /// A command from browser `id`, whose signature the runtime checked.
    /// It runs as its identity's — the reply goes to the browser alone —
    /// unless the identity is no longer paired or the command is one a
    /// browser may not send ([`browser_may_send`]).
    pub(super) fn on_web_command(&mut self, id: String, by: &str, msg: PhoneToBridge) {
        let Some(identity) = self.identity_of_npub(by) else {
            log::info!("[Engine] Ignoring a browser command: the identity that let it in is not paired");
            self.out.push(Effect::WebEndBrowsers { by: by.to_string() });
            return;
        };
        if !browser_may_send(&msg) {
            log::info!("[Engine] Ignoring a command a browser may not send");
            return;
        }
        self.browser_present(&id, &identity);
        let client = Addressee::browser(&identity, &id);
        if let PhoneToBridge::Presence(m) = &msg {
            let next = WatchState::Watching(if m.away { None } else { m.watching.clone() });
            let Some(browser) = self.browsers.get_mut(&id) else { return };
            if browser.watch != next {
                browser.watch = next.clone();
                // A browser that starts watching a session is caught up on
                // its live parts at once, as a phone's client is.
                if let WatchState::Watching(Some(session)) = next {
                    self.catch_up_live_text(&identity, &client.key, &session);
                }
            }
            return;
        }
        self.requester = Some(client);
        self.dispatch(msg, &identity, TerminalVia::Unknown);
    }

    /// The browsers of `identity` a copy of `message` goes to: every one
    /// with a stream open, narrowed to those watching the session for live
    /// text. Never a terminal's output — a browser opens no terminal.
    pub(super) fn browser_copies(&self, identity: &str, message: &BridgeToPhone) -> Vec<Addressee> {
        self.browsers
            .iter()
            .filter(|(_, b)| b.identity == identity)
            .filter(|(_, b)| match message {
                BridgeToPhone::Partial(m) => b.watch.wants(&m.session_id),
                BridgeToPhone::TerminalOutput(_) => false,
                _ => true,
            })
            .map(|(id, _)| Addressee::browser(identity, id))
            .collect()
    }

    /// `identity` was unpaired: the browsers it let in go with it.
    pub(super) fn end_identity_browsers(&mut self, identity: &str, npub: &str) {
        self.browsers.retain(|_, b| b.identity != identity);
        self.out.push(Effect::WebEndBrowsers { by: npub.to_string() });
    }
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn a_typed_code_is_read_in_any_case_with_or_without_its_dash() {
        assert_eq!(normalize("k7qm-4xpa"), "K7QM-4XPA");
        assert_eq!(normalize(" K7QM4XPA "), "K7QM-4XPA");
        assert_eq!(normalize("K7QM 4XPA"), "K7QM-4XPA");
        assert_eq!(normalize("ABC"), "ABC", "a wrong length is kept as typed, and matches nothing");
    }
}
