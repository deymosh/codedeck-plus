//! Browser sign-in for the bridge's web page.
//!
//! The page shows a short code to a browser that asks to sign in, and tells
//! the engine ([`Input::WebSignInPending`]); a paired phone sends that code
//! (`web-sign-in`), and the engine — which already knows the command came
//! from a paired identity — matches it and lets that browser in
//! ([`Effect::WebSignedIn`]). A code works once, and only until it lapses:
//! anyone who reads it off the screen still needs a paired phone to use it.

use std::collections::HashMap;

use protocol::events::{BridgeToPhone, WebSignInResultMsg};

use super::Engine;
use crate::io::Effect;

/// Codes the page is showing at once; the soonest to lapse goes first past
/// it (the page caps its own pending sign-ins below this).
const MAX_CODES: usize = 64;

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
        while codes.len() >= MAX_CODES {
            let Some(soonest) = codes.iter().min_by_key(|(_, e)| **e).map(|(c, _)| c.clone()) else { break };
            codes.remove(&soonest);
        }
        codes.insert(normalize(&code), expires_ms);
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
