//! Pairing: the QR a phone scans, and the limit on rejection replies.
//!
//! The QR carries `codedeck://pair?npub=…&relays=…&machine=…&token=…`, plus
//! `&netid=…&meshadmin=…` when the phone should also join the mesh. The token
//! is a one-time secret for this window; the phone echoes it in its
//! `pair-request` and only a matching token pairs. Nothing else in the URL is
//! secret, so the text shown to the operator is the URL itself.

/// How long a pairing window accepts pair requests.
pub const DEFAULT_PAIRING_WINDOW_MS: u64 = 10 * 60_000;

/// At most this many negative `pair-ack`s per [`PAIR_NACK_WINDOW_MS`]. A
/// handful covers a user retrying a mistyped pairing; beyond that, each
/// rejection an unpaired sender triggers would be a relay write it gets for
/// free, so further ones are logged and dropped.
pub const MAX_PAIR_NACKS: u32 = 5;
pub const PAIR_NACK_WINDOW_MS: u64 = 10 * 60_000;

pub struct PairingUrlParts<'a> {
    pub npub: &'a str,
    pub relays: &'a [String],
    pub machine: &'a str,
    pub token: &'a str,
    /// Mesh admin device id and network id; both or neither.
    pub mesh: Option<(&'a str, &'a str)>,
}

/// JavaScript's `encodeURIComponent`, which the phone's parser mirrors.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn pairing_url(parts: &PairingUrlParts<'_>) -> String {
    let relays: Vec<String> = parts.relays.iter().map(|r| encode_uri_component(r)).collect();
    let mut url = format!(
        "codedeck://pair?npub={}&relays={}&machine={}&token={}",
        parts.npub,
        relays.join(","),
        encode_uri_component(parts.machine),
        encode_uri_component(parts.token),
    );
    if let Some((admin, netid)) = parts.mesh {
        url.push_str(&format!(
            "&netid={}&meshadmin={}",
            encode_uri_component(netid),
            encode_uri_component(admin)
        ));
    }
    url
}

/// Counts negative pair-acks in fixed windows.
#[derive(Debug, Default)]
pub struct NackBudget {
    window_start_ms: u64,
    count: u32,
    started: bool,
}

impl NackBudget {
    /// Whether one more rejection may be answered at `now_ms`.
    pub fn allow(&mut self, now_ms: u64) -> bool {
        if !self.started || now_ms.saturating_sub(self.window_start_ms) >= PAIR_NACK_WINDOW_MS {
            self.window_start_ms = now_ms;
            self.count = 0;
            self.started = true;
        }
        self.count += 1;
        self.count <= MAX_PAIR_NACKS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_url_with_encoded_relays_machine_and_token() {
        let relays = vec!["wss://relay.one".to_string(), "ws://abc.onion/x?y=1".to_string()];
        let url = pairing_url(&PairingUrlParts {
            npub: "npub1xyz",
            relays: &relays,
            machine: "my laptop",
            token: "t0k",
            mesh: None,
        });
        assert_eq!(
            url,
            "codedeck://pair?npub=npub1xyz&relays=wss%3A%2F%2Frelay.one,ws%3A%2F%2Fabc.onion%2Fx%3Fy%3D1&machine=my%20laptop&token=t0k"
        );
    }

    #[test]
    fn carries_the_mesh_join_pair_when_given() {
        let url = pairing_url(&PairingUrlParts {
            npub: "npub1",
            relays: &[],
            machine: "m",
            token: "t",
            mesh: Some(("npub1admin", "net-1")),
        });
        assert!(url.ends_with("&token=t&netid=net-1&meshadmin=npub1admin"), "{url}");
    }

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_uri_component("a-b_c.d!e~f*g'h(i)j"), "a-b_c.d!e~f*g'h(i)j");
        assert_eq!(encode_uri_component("ñ /&="), "%C3%B1%20%2F%26%3D");
    }

    #[test]
    fn the_nack_budget_allows_five_per_window_then_resets() {
        let mut b = NackBudget::default();
        for _ in 0..MAX_PAIR_NACKS {
            assert!(b.allow(1000));
        }
        assert!(!b.allow(2000));
        assert!(b.allow(1000 + PAIR_NACK_WINDOW_MS));
    }
}
