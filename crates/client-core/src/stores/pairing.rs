//! `pairing` — `codedeck://pair` URL parsing + the pair-flow FSM. Port of the
//! pure half of `apps/mobile/src/core/stores/pairing.ts`.
//!
//! URL: `codedeck://pair?npub=<npub>&relays=<enc>,<enc>&machine=<enc>&token=<enc>[&netid=<enc>&meshadmin=<enc>]`
//!
//! Flow: parse (QR / pasted link) → `BeginPair` sends the token-carrying
//! `pair-request` and arms the CDX-040 deadline → `pair-ack` → `Paired`
//! (machine registered) or `Failed` (`bad-token` / `window-closed` / the
//! phone's own timeout). Manual fallback: the user types the bridge npub +
//! token.
//!
//! The deadline timer and the send / candidate / paired seams are the
//! runtime's; the FSM emits [`PairingEffect`]s.

use protocol::crypto::hex_from_npub;
use protocol::capabilities::BridgeHostKind;
use protocol::events::{PairAckMsg, PairAckReason};

/// CDX-013: a hostile pairing link cannot flood the global relay set.
pub const MAX_PAIRING_RELAYS: usize = 5;

/// CDX-040: how long the phone waits for a `pair-ack` before calling it. The
/// bridge's own window is 600s and it cannot nack a request it never
/// subscribed for, so the phone must own its bound.
pub const PAIR_ACK_TIMEOUT_MS: u64 = 60_000;

/// The failure text a CDX-040 timeout shows — names the three real causes
/// silence alone cannot tell apart.
pub fn pair_timeout_error(ms: u64) -> String {
    format!(
        "no answer from the bridge within {}s — its pairing window may have \
         closed, the one-time token may be mistyped, or the phone and the \
         bridge may not share a relay",
        ms / 1000
    )
}

// --- URL parsing ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPairingUrl {
    pub npub: String,
    pub pubkey_hex: String,
    pub relays: Vec<String>,
    pub machine: String,
    pub token: String,
    /// Active mesh network id (CDX-028 manual-join; pairs with `mesh_admin`).
    pub netid: Option<String>,
    /// Mesh admin device id (npub) for the engine's `manual_add_network`.
    pub mesh_admin: Option<String>,
}

pub type ParsePairingResult = Result<ParsedPairingUrl, String>;

const PAIRING_URL_PREFIX: &str = "codedeck://pair";

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `decodeURIComponent`-strict: a `%` not followed by two hex digits is an
/// error (unlike the lenient `percent-encoding` crate); the result must be
/// valid UTF-8 (so `%FF%FE` is an error, matching the JS throw).
fn decode_uri_component(s: &str) -> Result<String, ()> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 3 > bytes.len() {
                return Err(());
            }
            let hi = hex_val(bytes[i + 1]).ok_or(())?;
            let lo = hex_val(bytes[i + 2]).ok_or(())?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

fn is_relay_url(relay: &str) -> bool {
    relay
        .strip_prefix("wss://")
        .or_else(|| relay.strip_prefix("ws://"))
        .is_some_and(|rest| !rest.is_empty())
}

/// Parse + validate a pairing URL. Never panics — malformed input is `Err`.
///
/// `relays` is split on `,` BEFORE percent-decoding (the builder encodes each
/// relay individually, so encoded relays carry no bare commas).
pub fn parse_pairing_url(url: &str) -> ParsePairingResult {
    let trimmed = url.trim();
    if !trimmed.starts_with(PAIRING_URL_PREFIX) {
        return Err("not a codedeck://pair URL".to_string());
    }
    let query_index = trimmed.find('?');
    let rest = &trimmed[PAIRING_URL_PREFIX.len()..query_index.unwrap_or(trimmed.len())];
    if !rest.is_empty() && rest != "/" {
        return Err("not a codedeck://pair URL".to_string());
    }
    let Some(qi) = query_index else {
        return Err("missing query parameters".to_string());
    };

    // RAW values (relays must be split before decoding).
    let mut params: Vec<(&str, &str)> = Vec::new();
    for pair in trimmed[qi + 1..].split('&') {
        if pair.is_empty() {
            continue;
        }
        if let Some(eq) = pair.find('=') {
            params.push((&pair[..eq], &pair[eq + 1..]));
        }
    }
    let get = |key: &str| params.iter().find(|(k, _)| *k == key).map(|(_, v)| *v);

    let npub = get("npub").unwrap_or("");
    if npub.is_empty() {
        return Err("missing npub".to_string());
    }
    let pubkey_hex = hex_from_npub(npub).map_err(|_| "invalid npub".to_string())?;

    let token = match get("token").unwrap_or("") {
        "" => None,
        raw => decode_uri_component(raw).ok(),
    }
    .ok_or_else(|| "missing token".to_string())?;

    let machine = match get("machine").unwrap_or("") {
        "" => None,
        raw => decode_uri_component(raw).ok(),
    }
    .ok_or_else(|| "missing machine name".to_string())?;

    let mut relays = Vec::new();
    for enc in get("relays").unwrap_or("").split(',') {
        if enc.is_empty() {
            continue;
        }
        let relay = decode_uri_component(enc).map_err(|_| "malformed relay list".to_string())?;
        if !is_relay_url(&relay) {
            return Err(format!("invalid relay URL: {relay}"));
        }
        relays.push(relay);
    }
    if relays.is_empty() {
        return Err("missing relays".to_string());
    }
    if relays.len() > MAX_PAIRING_RELAYS {
        return Err(format!("too many relays (max {MAX_PAIRING_RELAYS})"));
    }

    let netid = get("netid").and_then(|r| decode_uri_component(r).ok());
    let mesh_admin = get("meshadmin").and_then(|r| decode_uri_component(r).ok());

    Ok(ParsedPairingUrl {
        npub: npub.to_string(),
        pubkey_hex,
        relays,
        machine,
        token,
        netid,
        mesh_admin,
    })
}

/// Manual fallback: the bridge npub + token typed by the user. `machine` is the
/// `(manual)` placeholder until the `pair-ack` carries the real name (CDX-041).
pub fn parse_manual_pair(npub: &str, token: &str) -> ParsePairingResult {
    let npub = npub.trim();
    let token = token.trim();
    let pubkey_hex = hex_from_npub(npub).map_err(|_| "invalid npub".to_string())?;
    if token.is_empty() {
        return Err("missing token".to_string());
    }
    Ok(ParsedPairingUrl {
        npub: npub.to_string(),
        pubkey_hex,
        relays: Vec::new(),
        machine: "(manual)".to_string(),
        token: token.to_string(),
        netid: None,
        mesh_admin: None,
    })
}

// --- pair-flow FSM -------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PairingPhase {
    #[default]
    Idle,
    AwaitingAck,
    Paired,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingCandidate {
    pub pubkey_hex: String,
    pub npub: String,
    /// Machine name claimed by the URL (`(manual)` for the npub fallback) —
    /// display only until the `pair-ack` / first heartbeat carries the real
    /// name.
    pub machine: String,
    pub relays: Vec<String>,
    pub token: String,
    pub netid: Option<String>,
    pub mesh_admin: Option<String>,
}

impl PairingCandidate {
    fn from_parts(p: &ParsedPairingUrl) -> Self {
        Self {
            pubkey_hex: p.pubkey_hex.clone(),
            npub: p.npub.clone(),
            machine: p.machine.clone(),
            relays: p.relays.clone(),
            token: p.token.clone(),
            netid: p.netid.clone(),
            mesh_admin: p.mesh_admin.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PairingState {
    pub phase: PairingPhase,
    pub candidate: Option<PairingCandidate>,
    pub error: Option<String>,
    /// CDX-040: this `Failed` came from the phone's own deadline, not a bridge
    /// nack — so a late ack is still honoured. Reset by every fresh attempt.
    pub timed_out: bool,
    /// CDX-013: a deep-link URL awaiting explicit user confirmation — nothing
    /// is sent and no candidate registered until confirmed.
    pub staged: Option<ParsedPairingUrl>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PairingEvent {
    BeginPair { parts: ParsedPairingUrl, label: String },
    StagePair(ParsedPairingUrl),
    ConfirmStaged { label: String },
    DismissStaged,
    DeadlineFired,
    PairAck { machine_pubkey: String, msg: PairAckMsg },
    Reset,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PairingEffect {
    ArmDeadline { ms: u64 },
    /// Exactly one deadline is ever armed — every exit from `AwaitingAck`
    /// disarms it first.
    DisarmDeadline,
    /// Make the candidate visible to the subscription layer BEFORE the request
    /// goes out (the ack must pass the authors filter).
    NotifyCandidate(PairingCandidate),
    /// The runtime stamps its own `npub` / `pubkey_hex` onto the `pair-request`.
    SendPairRequest {
        to: String,
        label: String,
        token: String,
    },
    OnPaired {
        candidate: PairingCandidate,
        machine_name: String,
        host: Option<BridgeHostKind>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairingResult {
    pub state: PairingState,
    pub effects: Vec<PairingEffect>,
}

fn reason_str(reason: Option<PairAckReason>) -> String {
    match reason {
        Some(PairAckReason::BadToken) => "bad-token",
        Some(PairAckReason::WindowClosed) => "window-closed",
        None => "rejected",
    }
    .to_string()
}

fn begin_pair(prev_staged: Option<ParsedPairingUrl>, parts: &ParsedPairingUrl, label: &str, timeout_ms: u64) -> PairingResult {
    let candidate = PairingCandidate::from_parts(parts);
    PairingResult {
        state: PairingState {
            phase: PairingPhase::AwaitingAck,
            candidate: Some(candidate.clone()),
            error: None,
            timed_out: false,
            staged: prev_staged,
        },
        effects: vec![
            PairingEffect::DisarmDeadline,
            PairingEffect::ArmDeadline { ms: timeout_ms },
            PairingEffect::NotifyCandidate(candidate),
            PairingEffect::SendPairRequest {
                to: parts.pubkey_hex.clone(),
                label: label.to_string(),
                token: parts.token.clone(),
            },
        ],
    }
}

/// The FSM. Deterministic; every arm is a TS `case`.
pub fn pairing_reducer(state: &PairingState, event: PairingEvent, timeout_ms: u64) -> PairingResult {
    let unchanged = || PairingResult {
        state: state.clone(),
        effects: vec![],
    };

    match event {
        PairingEvent::BeginPair { parts, label } => {
            begin_pair(state.staged.clone(), &parts, &label, timeout_ms)
        }

        PairingEvent::StagePair(parts) => PairingResult {
            state: PairingState {
                staged: Some(parts),
                ..state.clone()
            },
            effects: vec![],
        },

        PairingEvent::ConfirmStaged { label } => match &state.staged {
            None => unchanged(),
            Some(staged) => begin_pair(None, &staged.clone(), &label, timeout_ms),
        },

        PairingEvent::DismissStaged => PairingResult {
            state: PairingState {
                staged: None,
                ..state.clone()
            },
            effects: vec![],
        },

        PairingEvent::DeadlineFired => {
            if state.phase != PairingPhase::AwaitingAck {
                return unchanged();
            }
            PairingResult {
                state: PairingState {
                    phase: PairingPhase::Failed,
                    error: Some(pair_timeout_error(timeout_ms)),
                    timed_out: true,
                    ..state.clone()
                },
                effects: vec![],
            }
        }

        PairingEvent::PairAck { machine_pubkey, msg } => {
            let acceptable = state.phase == PairingPhase::AwaitingAck
                || (state.phase == PairingPhase::Failed && state.timed_out);
            let Some(candidate) = &state.candidate else {
                return unchanged();
            };
            if !acceptable || candidate.pubkey_hex != machine_pubkey {
                return unchanged();
            }

            if !msg.ok {
                return PairingResult {
                    state: PairingState {
                        phase: PairingPhase::Failed,
                        error: Some(reason_str(msg.reason)),
                        timed_out: false,
                        ..state.clone()
                    },
                    effects: vec![PairingEffect::DisarmDeadline],
                };
            }

            // Merge the ack's relays into the candidate's (deduped, URL first)
            // — this is how a manual-npub pairing learns where the bridge lives.
            let mut relays = candidate.relays.clone();
            for r in msg.relays.into_iter().flatten() {
                if !relays.contains(&r) {
                    relays.push(r);
                }
            }
            // CDX-041: the ack is where a MANUAL pairing learns the real name.
            let machine_name = if msg.machine.is_empty() {
                candidate.machine.clone()
            } else {
                msg.machine.clone()
            };
            let paired = PairingCandidate {
                relays,
                machine: machine_name.clone(),
                ..candidate.clone()
            };
            PairingResult {
                state: PairingState {
                    phase: PairingPhase::Paired,
                    candidate: Some(paired.clone()),
                    error: None,
                    timed_out: false,
                    staged: state.staged.clone(),
                },
                effects: vec![
                    PairingEffect::DisarmDeadline,
                    PairingEffect::OnPaired {
                        candidate: paired,
                        machine_name,
                        host: msg.host,
                    },
                ],
            }
        }

        PairingEvent::Reset => PairingResult {
            state: PairingState::default(),
            effects: vec![PairingEffect::DisarmDeadline],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::crypto::generate_keypair;

    fn enc(s: &str) -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    }

    fn build_url(npub: &str, relays: &[&str], machine: &str, token: &str, mesh: Option<(&str, &str)>) -> String {
        let relays_param = relays.iter().map(|r| enc(r)).collect::<Vec<_>>().join(",");
        let mut url = format!(
            "codedeck://pair?npub={npub}&relays={relays_param}&machine={}&token={}",
            enc(machine),
            enc(token)
        );
        if let Some((netid, admin)) = mesh {
            url.push_str(&format!("&netid={}&meshadmin={}", enc(netid), enc(admin)));
        }
        url
    }

    fn bridge_npub() -> String {
        generate_keypair().npub
    }

    // --- parse ---

    #[test]
    fn parses_the_builder_url_round_trip() {
        let kp = generate_keypair();
        let url = build_url(
            &kp.npub,
            &["wss://relay2.descendant.io", "wss://relay.primal.net"],
            "my laptop (cli)",
            "tok-123",
            None,
        );
        let p = parse_pairing_url(&url).unwrap();
        assert_eq!(p.npub, kp.npub);
        assert_eq!(p.pubkey_hex, kp.pubkey_hex);
        assert_eq!(p.relays, vec!["wss://relay2.descendant.io", "wss://relay.primal.net"]);
        assert_eq!(p.machine, "my laptop (cli)");
        assert_eq!(p.token, "tok-123");
        assert_eq!(p.netid, None);
        assert_eq!(p.mesh_admin, None);
    }

    #[test]
    fn parses_the_mesh_variant_and_tolerates_whitespace() {
        let url = build_url(&bridge_npub(), &["wss://r.example"], "box", "t", Some(("a237c978", "npub1admindevice")));
        let p = parse_pairing_url(&format!("  {url}\n")).unwrap();
        assert_eq!(p.netid.as_deref(), Some("a237c978"));
        assert_eq!(p.mesh_admin.as_deref(), Some("npub1admindevice"));
    }

    #[test]
    fn rejects_malformed_urls_with_the_exact_message() {
        let n = bridge_npub();
        let cases: Vec<(String, &str)> = vec![
            ("https://pair?npub=x&relays=y&machine=z&token=t".into(), "not a codedeck://pair URL"),
            ("codedeck://unpair?npub=x".into(), "not a codedeck://pair URL"),
            ("codedeck://pair".into(), "missing query parameters"),
            ("codedeck://pair?".into(), "missing npub"),
            ("codedeck://pair?relays=wss%3A%2F%2Fr&machine=m&token=t".into(), "missing npub"),
            ("codedeck://pair?npub=npub1garbage&relays=wss%3A%2F%2Fr&machine=m&token=t".into(), "invalid npub"),
            (
                "codedeck://pair?npub=nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5&relays=wss%3A%2F%2Fr&machine=m&token=t".into(),
                "invalid npub",
            ),
            (format!("codedeck://pair?npub={n}&relays=wss%3A%2F%2Fr&machine=m"), "missing token"),
            (format!("codedeck://pair?npub={n}&relays=wss%3A%2F%2Fr&token=t"), "missing machine name"),
            (format!("codedeck://pair?npub={n}&machine=m&token=t"), "missing relays"),
            (
                format!("codedeck://pair?npub={n}&relays=https%3A%2F%2Fnot-a-relay&machine=m&token=t"),
                "invalid relay URL: https://not-a-relay",
            ),
            (format!("codedeck://pair?npub={n}&relays=%ZZbroken&machine=m&token=t"), "malformed relay list"),
        ];
        for (url, want) in cases {
            assert_eq!(parse_pairing_url(&url).unwrap_err(), want, "url: {url}");
        }
    }

    #[test]
    fn caps_the_relay_list() {
        let n = bridge_npub();
        let six: Vec<String> = (0..6).map(|i| format!("wss://r{i}.example")).collect();
        let six_ref: Vec<&str> = six.iter().map(String::as_str).collect();
        assert!(parse_pairing_url(&build_url(&n, &six_ref, "box", "t", None))
            .unwrap_err()
            .contains("too many relays"));
        assert!(parse_pairing_url(&build_url(&n, &six_ref[..5], "box", "t", None)).is_ok());
    }

    #[test]
    fn never_panics_on_fuzzed_garbage() {
        for g in [
            "codedeck://pair?=&&&==?",
            "codedeck://pair????",
            "\u{0}codedeck://pair?npub=x",
            "codedeck://pair?npub=%FF%FE&relays=,&machine=&token=",
            "codedeck://pair/?npub",
        ] {
            assert!(parse_pairing_url(g).is_err());
        }
    }

    #[test]
    fn parse_manual_pair_validates() {
        let n = bridge_npub();
        assert_eq!(parse_manual_pair("npub1garbage", "tok").unwrap_err(), "invalid npub");
        assert_eq!(parse_manual_pair(&n, "   ").unwrap_err(), "missing token");
        let p = parse_manual_pair(&format!(" {n} "), " tok ").unwrap();
        assert_eq!(p.token, "tok");
        assert_eq!(p.machine, "(manual)");
        assert!(p.relays.is_empty());
    }

    // --- FSM ---

    const CFG: u64 = PAIR_ACK_TIMEOUT_MS;

    fn parts(mesh: Option<(&str, &str)>) -> ParsedPairingUrl {
        parse_pairing_url(&build_url(&bridge_npub(), &["wss://r.example"], "box", "tok", mesh)).unwrap()
    }

    fn ack(machine: &str, ok: bool, reason: Option<PairAckReason>, relays: Option<Vec<String>>, host: Option<BridgeHostKind>) -> PairAckMsg {
        PairAckMsg { machine: machine.to_string(), ok, reason, relays, host }
    }

    fn run(mut state: PairingState, events: Vec<PairingEvent>) -> PairingResult {
        let mut effects = Vec::new();
        for e in events {
            let r = pairing_reducer(&state, e, CFG);
            state = r.state;
            effects.extend(r.effects);
        }
        PairingResult { state, effects }
    }

    #[test]
    fn begin_pair_registers_the_candidate_before_the_request() {
        let p = parts(None);
        let r = pairing_reducer(&PairingState::default(), PairingEvent::BeginPair { parts: p.clone(), label: "My Phone".into() }, CFG);
        assert_eq!(r.state.phase, PairingPhase::AwaitingAck);
        // NotifyCandidate must precede SendPairRequest.
        let ni = r.effects.iter().position(|e| matches!(e, PairingEffect::NotifyCandidate(_))).unwrap();
        let si = r.effects.iter().position(|e| matches!(e, PairingEffect::SendPairRequest { .. })).unwrap();
        assert!(ni < si);
        match &r.effects[si] {
            PairingEffect::SendPairRequest { to, label, token } => {
                assert_eq!(to, &p.pubkey_hex);
                assert_eq!(label, "My Phone");
                assert_eq!(token, "tok");
            }
            _ => unreachable!(),
        }
        assert!(r.effects.contains(&PairingEffect::ArmDeadline { ms: CFG }));
    }

    #[test]
    fn pair_ack_ok_pairs_and_carries_the_bridge_reported_name() {
        let p = parts(None);
        let begun = pairing_reducer(&PairingState::default(), PairingEvent::BeginPair { parts: p.clone(), label: "P".into() }, CFG);
        let r = pairing_reducer(&begun.state, PairingEvent::PairAck { machine_pubkey: p.pubkey_hex, msg: ack("real-name", true, None, None, None) }, CFG);
        assert_eq!(r.state.phase, PairingPhase::Paired);
        match r.effects.iter().find(|e| matches!(e, PairingEffect::OnPaired { .. })).unwrap() {
            PairingEffect::OnPaired { machine_name, candidate, .. } => {
                assert_eq!(machine_name, "real-name");
                assert_eq!(candidate.relays, vec!["wss://r.example"]);
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn ack_ok_pairs_with_mesh_info_riding_the_candidate() {
        let p = parts(Some(("a237c978", "npub1admindevice")));
        let begun = pairing_reducer(&PairingState::default(), PairingEvent::BeginPair { parts: p.clone(), label: "P".into() }, CFG);
        assert!(begun.effects.iter().any(|e| matches!(e, PairingEffect::NotifyCandidate(c) if c.mesh_admin.as_deref() == Some("npub1admindevice") && c.netid.as_deref() == Some("a237c978"))));
        let r = pairing_reducer(&begun.state, PairingEvent::PairAck { machine_pubkey: p.pubkey_hex.clone(), msg: ack("box", true, None, None, None) }, CFG);
        assert_eq!(r.state.phase, PairingPhase::Paired);
        match r.effects.iter().find(|e| matches!(e, PairingEffect::OnPaired { .. })).unwrap() {
            PairingEffect::OnPaired { candidate, machine_name, .. } => {
                assert_eq!(machine_name, "box");
                assert_eq!(candidate.mesh_admin.as_deref(), Some("npub1admindevice"));
                assert_eq!(candidate.netid.as_deref(), Some("a237c978"));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn ack_not_ok_fails_with_the_reason_no_on_paired() {
        let p = parts(None);
        let begun = pairing_reducer(&PairingState::default(), PairingEvent::BeginPair { parts: p.clone(), label: "P".into() }, CFG);
        let r = pairing_reducer(&begun.state, PairingEvent::PairAck { machine_pubkey: p.pubkey_hex.clone(), msg: ack("box", false, Some(PairAckReason::BadToken), None, None) }, CFG);
        assert_eq!(r.state.phase, PairingPhase::Failed);
        assert_eq!(r.state.error.as_deref(), Some("bad-token"));
        assert!(!r.effects.iter().any(|e| matches!(e, PairingEffect::OnPaired { .. })));
    }

    #[test]
    fn an_ack_from_the_wrong_pubkey_or_outside_a_flow_is_ignored() {
        let idle = pairing_reducer(&PairingState::default(), PairingEvent::PairAck { machine_pubkey: "x".into(), msg: ack("box", true, None, None, None) }, CFG);
        assert_eq!(idle.state.phase, PairingPhase::Idle);
        let p = parts(None);
        let begun = pairing_reducer(&PairingState::default(), PairingEvent::BeginPair { parts: p, label: "P".into() }, CFG);
        let r = pairing_reducer(&begun.state, PairingEvent::PairAck { machine_pubkey: "someone-else".into(), msg: ack("box", true, None, None, None) }, CFG);
        assert_eq!(r.state.phase, PairingPhase::AwaitingAck);
    }

    #[test]
    fn manual_pairing_learns_relays_host_and_name_from_the_ack() {
        let p = parse_manual_pair(&bridge_npub(), "tok").unwrap();
        let begun = pairing_reducer(&PairingState::default(), PairingEvent::BeginPair { parts: p.clone(), label: "P".into() }, CFG);
        assert_eq!(begun.state.candidate.as_ref().unwrap().machine, "(manual)");
        let r = pairing_reducer(
            &begun.state,
            PairingEvent::PairAck {
                machine_pubkey: p.pubkey_hex.clone(),
                msg: ack("laptop", true, None, Some(vec!["wss://relay2.descendant.io".into(), "wss://relay.primal.net".into()]), Some(BridgeHostKind::Cli)),
            },
            CFG,
        );
        assert_eq!(r.state.candidate.as_ref().unwrap().machine, "laptop");
        match r.effects.iter().find(|e| matches!(e, PairingEffect::OnPaired { .. })).unwrap() {
            PairingEffect::OnPaired { candidate, host, .. } => {
                assert_eq!(candidate.relays, vec!["wss://relay2.descendant.io", "wss://relay.primal.net"]);
                assert_eq!(*host, Some(BridgeHostKind::Cli));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn a_nameless_ack_keeps_the_manual_placeholder() {
        let p = parse_manual_pair(&bridge_npub(), "tok").unwrap();
        let begun = pairing_reducer(&PairingState::default(), PairingEvent::BeginPair { parts: p.clone(), label: "P".into() }, CFG);
        let r = pairing_reducer(&begun.state, PairingEvent::PairAck { machine_pubkey: p.pubkey_hex, msg: ack("", true, None, None, None) }, CFG);
        assert_eq!(r.state.candidate.as_ref().unwrap().machine, "(manual)");
    }

    #[test]
    fn qr_pairing_merges_ack_relays_deduped_url_first() {
        let p = parse_pairing_url(&build_url(&bridge_npub(), &["wss://a.example", "wss://b.example"], "box", "tok", None)).unwrap();
        let begun = pairing_reducer(&PairingState::default(), PairingEvent::BeginPair { parts: p.clone(), label: "P".into() }, CFG);
        let r = pairing_reducer(&begun.state, PairingEvent::PairAck { machine_pubkey: p.pubkey_hex, msg: ack("box", true, None, Some(vec!["wss://b.example".into(), "wss://c.example".into()]), None) }, CFG);
        match r.effects.iter().find(|e| matches!(e, PairingEffect::OnPaired { .. })).unwrap() {
            PairingEffect::OnPaired { candidate, .. } => {
                assert_eq!(candidate.relays, vec!["wss://a.example", "wss://b.example", "wss://c.example"]);
            }
            _ => unreachable!(),
        }
    }

    // --- CDX-040 deadline ---

    #[test]
    fn silence_past_the_deadline_fails_with_all_three_causes_named() {
        let p = parse_manual_pair(&bridge_npub(), "tok").unwrap();
        let begun = pairing_reducer(&PairingState::default(), PairingEvent::BeginPair { parts: p, label: "P".into() }, CFG);
        let r = pairing_reducer(&begun.state, PairingEvent::DeadlineFired, CFG);
        assert_eq!(r.state.phase, PairingPhase::Failed);
        assert!(r.state.timed_out);
        let err = r.state.error.unwrap();
        assert!(err.contains("window may have closed"));
        assert!(err.contains("token may be mistyped"));
        assert!(err.contains("share a relay"));
    }

    #[test]
    fn a_late_ack_after_a_timeout_still_pairs() {
        let p = parse_manual_pair(&bridge_npub(), "tok").unwrap();
        let s = run(PairingState::default(), vec![
            PairingEvent::BeginPair { parts: p.clone(), label: "P".into() },
            PairingEvent::DeadlineFired,
        ]);
        assert_eq!(s.state.phase, PairingPhase::Failed);
        let r = pairing_reducer(&s.state, PairingEvent::PairAck { machine_pubkey: p.pubkey_hex, msg: ack("box", true, None, None, None) }, CFG);
        assert_eq!(r.state.phase, PairingPhase::Paired);
        assert!(!r.state.timed_out);
    }

    #[test]
    fn a_bridge_nack_is_terminal_a_later_ack_is_ignored() {
        let p = parse_manual_pair(&bridge_npub(), "tok").unwrap();
        let s = run(PairingState::default(), vec![
            PairingEvent::BeginPair { parts: p.clone(), label: "P".into() },
            PairingEvent::PairAck { machine_pubkey: p.pubkey_hex.clone(), msg: ack("box", false, Some(PairAckReason::BadToken), None, None) },
        ]);
        assert_eq!(s.state.phase, PairingPhase::Failed);
        assert!(!s.state.timed_out);
        let r = pairing_reducer(&s.state, PairingEvent::PairAck { machine_pubkey: p.pubkey_hex, msg: ack("box", true, None, None, None) }, CFG);
        assert_eq!(r.state.phase, PairingPhase::Failed);
        assert_eq!(r.state.error.as_deref(), Some("bad-token"));
    }

    #[test]
    fn deadline_fired_after_a_pair_is_ignored() {
        let p = parse_manual_pair(&bridge_npub(), "tok").unwrap();
        let s = run(PairingState::default(), vec![
            PairingEvent::BeginPair { parts: p.clone(), label: "P".into() },
            PairingEvent::PairAck { machine_pubkey: p.pubkey_hex, msg: ack("box", true, None, None, None) },
        ]);
        assert_eq!(s.state.phase, PairingPhase::Paired);
        let r = pairing_reducer(&s.state, PairingEvent::DeadlineFired, CFG);
        assert_eq!(r.state.phase, PairingPhase::Paired);
    }

    #[test]
    fn configurable_deadline_names_the_seconds() {
        let p = parse_manual_pair(&bridge_npub(), "tok").unwrap();
        let begun = pairing_reducer(&PairingState::default(), PairingEvent::BeginPair { parts: p, label: "P".into() }, 5_000);
        let r = pairing_reducer(&begun.state, PairingEvent::DeadlineFired, 5_000);
        assert!(r.state.error.unwrap().contains("5s"));
    }

    #[test]
    fn reset_returns_to_idle_and_disarms() {
        let p = parts(None);
        let begun = pairing_reducer(&PairingState::default(), PairingEvent::BeginPair { parts: p, label: "P".into() }, CFG);
        let r = pairing_reducer(&begun.state, PairingEvent::Reset, CFG);
        assert_eq!(r.state, PairingState::default());
        assert!(r.effects.contains(&PairingEffect::DisarmDeadline));
    }

    // --- CDX-013 staged deep link ---

    #[test]
    fn stage_pair_sends_nothing_and_registers_no_candidate() {
        let r = pairing_reducer(&PairingState::default(), PairingEvent::StagePair(parts(None)), CFG);
        assert!(r.state.staged.is_some());
        assert_eq!(r.state.phase, PairingPhase::Idle);
        assert!(r.effects.is_empty());
    }

    #[test]
    fn confirm_staged_runs_begin_pair_and_clears_the_staged_link() {
        let staged = pairing_reducer(&PairingState::default(), PairingEvent::StagePair(parts(None)), CFG).state;
        let r = pairing_reducer(&staged, PairingEvent::ConfirmStaged { label: "My Phone".into() }, CFG);
        assert!(r.state.staged.is_none());
        assert_eq!(r.state.phase, PairingPhase::AwaitingAck);
        assert!(r.effects.iter().any(|e| matches!(e, PairingEffect::SendPairRequest { label, token, .. } if label == "My Phone" && token == "tok")));
    }

    #[test]
    fn dismiss_then_confirm_is_a_no_op() {
        let staged = pairing_reducer(&PairingState::default(), PairingEvent::StagePair(parts(None)), CFG).state;
        let dismissed = pairing_reducer(&staged, PairingEvent::DismissStaged, CFG).state;
        assert!(dismissed.staged.is_none());
        let r = pairing_reducer(&dismissed, PairingEvent::ConfirmStaged { label: "P".into() }, CFG);
        assert_eq!(r.state.phase, PairingPhase::Idle);
        assert!(r.effects.is_empty());
    }

    #[test]
    fn reset_clears_a_staged_link_too() {
        let staged = pairing_reducer(&PairingState::default(), PairingEvent::StagePair(parts(None)), CFG).state;
        let r = pairing_reducer(&staged, PairingEvent::Reset, CFG);
        assert!(r.state.staged.is_none());
    }
}
