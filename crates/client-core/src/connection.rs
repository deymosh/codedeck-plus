//! Connection FSM — kills bug A ("relay connection keeps dropping") by design.
//! Pure port of the reducer half of `apps/mobile/src/core/stores/connection.ts`
//! (the effect *interpreter* + store live in `client-runtime`).
//!
//! ONE pure reducer consumes every connectivity signal (network online/offline,
//! visibility, resume, socket open/close, heartbeats, decrypt failures) and
//! returns the next state plus a list of effects. Policy, verbatim from the TS:
//!
//! - A visibility flip is DEBOUNCED and NEVER tears down a healthy socket.
//! - Reconnects back off exponentially (2s → 30s) with +25% jitter.
//! - Every successful (re)connect triggers `RefreshAndReconcile`.
//! - Decrypt failures increment a diagnostics counter and raise
//!   `needs_pairing_check` — they are NEVER a lost connection.
//! - Presence per machine is an honest `f(30515 age, socket state)`.
//! - CDX-020: subscriptions can die WITHOUT the socket closing;
//!   [`heartbeats_all_stale`] detects it so the caller can force a reconnect.

use std::collections::BTreeMap;

pub const RECONNECT_BASE_MS: u64 = 2_000;
pub const RECONNECT_MAX_MS: u64 = 30_000;
pub const RECONNECT_JITTER_FRACTION: f64 = 0.25;
pub const VISIBILITY_DEBOUNCE_MS: u64 = 500;
pub const DECRYPT_FAILURE_THRESHOLD: u32 = 3;
/// 30515 older than this (2.5× the bridge's 60s heartbeat interval) = stale.
pub const HEARTBEAT_STALE_AFTER_MS: u64 = 150_000;

/// Reconnect backoff + heartbeat-stale timing. Tor circuits need the longer
/// variant — see [`TOR_RECONNECT_CONFIG`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReconnectConfig {
    pub base_ms: u64,
    pub max_ms: u64,
    pub jitter_fraction: f64,
    pub heartbeat_stale_after_ms: u64,
}

pub const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = ReconnectConfig {
    base_ms: RECONNECT_BASE_MS,
    max_ms: RECONNECT_MAX_MS,
    jitter_fraction: RECONNECT_JITTER_FRACTION,
    heartbeat_stale_after_ms: HEARTBEAT_STALE_AFTER_MS,
};

pub const TOR_RECONNECT_CONFIG: ReconnectConfig = ReconnectConfig {
    base_ms: 8_000,
    max_ms: 60_000,
    jitter_fraction: RECONNECT_JITTER_FRACTION,
    heartbeat_stale_after_ms: 240_000,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    /// created, connect() not requested yet
    Idle,
    /// socket requested, waiting for open (EOSE)
    Connecting,
    /// live subscriptions
    Connected,
    /// socket lost while online — backoff timer running
    WaitingRetry,
    /// OS says no network — no socket, no retry timer
    Offline,
    /// deliberate shutdown — inert until connect-requested
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Live,
    Stale,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionState {
    pub status: ConnectionStatus,
    /// Consecutive failed/lost connection attempts (drives backoff).
    pub attempt: u32,
    pub online: bool,
    pub visible: bool,
    /// A hide event is being debounced.
    pub hidden_pending: bool,
    /// ms timestamp of the last successful socket-open; `None` before the first.
    pub last_connected_at: Option<u64>,
    /// Diagnostics: NIP-44 decrypt failures since start. Never a disconnect.
    pub decrypt_failures: u32,
    /// Raised at [`DECRYPT_FAILURE_THRESHOLD`] — the UI shows a "check pairing"
    /// banner instead of lying about connectivity.
    pub needs_pairing_check: bool,
    /// machine pubkey → ms timestamp of its last 30515 heartbeat.
    pub heartbeats: BTreeMap<String, u64>,
}

pub fn initial_connection_state() -> ConnectionState {
    ConnectionState {
        status: ConnectionStatus::Idle,
        attempt: 0,
        online: true,
        visible: true,
        hidden_pending: false,
        last_connected_at: None,
        decrypt_failures: 0,
        needs_pairing_check: false,
        heartbeats: BTreeMap::new(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConnectionEvent {
    ConnectRequested,
    DisconnectRequested,
    Online,
    Offline,
    Visibility { visible: bool },
    VisibilitySettled,
    Resume,
    SocketOpen { at: u64 },
    /// `random` (0..1) is the jitter source; the interpreter fills it in.
    SocketClose { random: Option<f64> },
    RetryDue,
    HeartbeatReceived { machine: String, at: u64 },
    DecryptFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionEffect {
    OpenSocket,
    CloseSocket,
    ScheduleRetry { delay_ms: u64 },
    CancelRetry,
    ScheduleVisibilityCheck { delay_ms: u64 },
    CancelVisibilityCheck,
    RefreshAndReconcile,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReducerResult {
    pub state: ConnectionState,
    pub effects: Vec<ConnectionEffect>,
}

/// Backoff delay for `attempt`: `exp(base → max cap) + jitter`.
pub fn backoff_delay_ms(attempt: u32, random: f64, config: &ReconnectConfig) -> u64 {
    let factor = 1u64.checked_shl(attempt).unwrap_or(u64::MAX);
    let base = config.base_ms.saturating_mul(factor).min(config.max_ms);
    let r = random.clamp(0.0, 1.0);
    let jitter = (r * base as f64 * config.jitter_fraction).floor() as u64;
    base + jitter
}

const CONNECT_EFFECTS: [ConnectionEffect; 2] =
    [ConnectionEffect::CancelRetry, ConnectionEffect::OpenSocket];

use ConnectionStatus as S;

/// The FSM. Deterministic; every branch is a TS `case`.
pub fn connection_reducer(
    state: &ConnectionState,
    event: &ConnectionEvent,
    config: &ReconnectConfig,
) -> ReducerResult {
    let no_effects = |s: ConnectionState| ReducerResult { state: s, effects: vec![] };
    let with = |s: ConnectionState, e: Vec<ConnectionEffect>| ReducerResult { state: s, effects: e };

    match event {
        ConnectionEvent::ConnectRequested => {
            if matches!(state.status, S::Connected | S::Connecting) {
                return no_effects(state.clone());
            }
            if !state.online {
                return no_effects(ConnectionState { status: S::Offline, attempt: 0, ..state.clone() });
            }
            with(
                ConnectionState { status: S::Connecting, attempt: 0, ..state.clone() },
                CONNECT_EFFECTS.to_vec(),
            )
        }

        ConnectionEvent::DisconnectRequested => with(
            ConnectionState { status: S::Stopped, hidden_pending: false, ..state.clone() },
            vec![
                ConnectionEffect::CancelRetry,
                ConnectionEffect::CancelVisibilityCheck,
                ConnectionEffect::CloseSocket,
            ],
        ),

        ConnectionEvent::Online => {
            let next = ConnectionState { online: true, ..state.clone() };
            if matches!(state.status, S::Connected | S::Connecting | S::Stopped | S::Idle) {
                return no_effects(next);
            }
            // offline / waiting-retry: the network is back — reconnect NOW with
            // a fresh backoff (a network change is a new world, not attempt N+1).
            with(
                ConnectionState { status: S::Connecting, attempt: 0, ..next },
                CONNECT_EFFECTS.to_vec(),
            )
        }

        ConnectionEvent::Offline => {
            if matches!(state.status, S::Stopped | S::Idle) {
                return no_effects(ConnectionState { online: false, ..state.clone() });
            }
            with(
                ConnectionState { online: false, status: S::Offline, attempt: 0, ..state.clone() },
                vec![ConnectionEffect::CancelRetry, ConnectionEffect::CloseSocket],
            )
        }

        ConnectionEvent::Visibility { visible: true } => {
            let mut effects = if state.hidden_pending {
                vec![ConnectionEffect::CancelVisibilityCheck]
            } else {
                vec![]
            };
            let next = ConnectionState { visible: true, hidden_pending: false, ..state.clone() };
            // Coming back to a dead connection while online → reconnect immediately.
            if state.online && matches!(state.status, S::WaitingRetry | S::Idle) {
                effects.extend(CONNECT_EFFECTS);
                return with(ConnectionState { status: S::Connecting, attempt: 0, ..next }, effects);
            }
            with(next, effects)
        }

        ConnectionEvent::Visibility { visible: false } => {
            // Going hidden: debounce only. A healthy socket is NEVER torn down.
            if state.hidden_pending {
                return no_effects(state.clone());
            }
            with(
                ConnectionState { hidden_pending: true, ..state.clone() },
                vec![ConnectionEffect::ScheduleVisibilityCheck { delay_ms: VISIBILITY_DEBOUNCE_MS }],
            )
        }

        ConnectionEvent::VisibilitySettled => no_effects(ConnectionState {
            visible: false,
            hidden_pending: false,
            ..state.clone()
        }),

        ConnectionEvent::Resume => {
            if state.status == S::Connected {
                // Cheap resync-on-resume: the socket survived, but the world may
                // have moved while the OS had us frozen.
                return with(state.clone(), vec![ConnectionEffect::RefreshAndReconcile]);
            }
            if state.status == S::Stopped || !state.online {
                return no_effects(state.clone());
            }
            with(
                ConnectionState { status: S::Connecting, attempt: 0, ..state.clone() },
                CONNECT_EFFECTS.to_vec(),
            )
        }

        ConnectionEvent::SocketOpen { at } => {
            if state.status == S::Stopped {
                return no_effects(state.clone());
            }
            with(
                ConnectionState {
                    status: S::Connected,
                    attempt: 0,
                    last_connected_at: Some(*at),
                    ..state.clone()
                },
                vec![ConnectionEffect::CancelRetry, ConnectionEffect::RefreshAndReconcile],
            )
        }

        ConnectionEvent::SocketClose { random } => {
            // Deliberate teardown (stopped) or already handled (offline): ignore.
            if matches!(state.status, S::Stopped | S::Offline | S::Idle) {
                return no_effects(state.clone());
            }
            if !state.online {
                return with(
                    ConnectionState { status: S::Offline, attempt: 0, ..state.clone() },
                    vec![ConnectionEffect::CancelRetry],
                );
            }
            let delay_ms = backoff_delay_ms(state.attempt, random.unwrap_or(0.0), config);
            with(
                ConnectionState { status: S::WaitingRetry, attempt: state.attempt + 1, ..state.clone() },
                vec![ConnectionEffect::ScheduleRetry { delay_ms }],
            )
        }

        ConnectionEvent::RetryDue => {
            if state.status != S::WaitingRetry || !state.online {
                return no_effects(state.clone());
            }
            with(
                ConnectionState { status: S::Connecting, ..state.clone() },
                vec![ConnectionEffect::OpenSocket],
            )
        }

        ConnectionEvent::HeartbeatReceived { machine, at } => {
            let mut heartbeats = state.heartbeats.clone();
            heartbeats.insert(machine.clone(), *at);
            no_effects(ConnectionState { heartbeats, ..state.clone() })
        }

        ConnectionEvent::DecryptFailure => {
            let decrypt_failures = state.decrypt_failures + 1;
            no_effects(ConnectionState {
                decrypt_failures,
                needs_pairing_check: state.needs_pairing_check
                    || decrypt_failures >= DECRYPT_FAILURE_THRESHOLD,
                ..state.clone()
            })
        }
    }
}

/// Presence per machine — the 3 honest states.
/// - socket down (any non-connected status) → `Offline`
/// - heartbeat within `stale_after_ms` → `Live`
/// - heartbeat older / never seen → `Stale` / `Offline`
pub fn presence_of(
    state: &ConnectionState,
    machine_pubkey: &str,
    now: u64,
    stale_after_ms: u64,
) -> Presence {
    if state.status != S::Connected {
        return Presence::Offline;
    }
    match state.heartbeats.get(machine_pubkey) {
        None => Presence::Offline,
        Some(&at) if now.saturating_sub(at) <= stale_after_ms => Presence::Live,
        Some(_) => Presence::Stale,
    }
}

/// CDX-020: dead-subscription detection. True when the socket claims
/// `Connected` but every machine heartbeat seen this run is older than the
/// stale threshold. Loop guard: also requires `last_connected_at` to be older
/// than the threshold, so every (re)connect gets a full stale window to hear
/// its first heartbeats.
pub fn heartbeats_all_stale(state: &ConnectionState, now: u64, stale_after_ms: u64) -> bool {
    if state.status != S::Connected {
        return false;
    }
    match state.last_connected_at {
        None => return false,
        Some(last) if now.saturating_sub(last) <= stale_after_ms => return false,
        Some(_) => {}
    }
    if state.heartbeats.is_empty() {
        return false;
    }
    state.heartbeats.values().all(|&at| now.saturating_sub(at) > stale_after_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CFG: &ReconnectConfig = &DEFAULT_RECONNECT_CONFIG;

    fn reduce(mut s: ConnectionState, events: &[ConnectionEvent]) -> ReducerResult {
        let mut effects = Vec::new();
        for e in events {
            let r = connection_reducer(&s, e, CFG);
            s = r.state;
            effects.extend(r.effects);
        }
        ReducerResult { state: s, effects }
    }

    fn has(effects: &[ConnectionEffect], f: impl Fn(&ConnectionEffect) -> bool) -> bool {
        effects.iter().any(f)
    }

    fn connected_state() -> ConnectionState {
        reduce(
            initial_connection_state(),
            &[ConnectionEvent::ConnectRequested, ConnectionEvent::SocketOpen { at: 1000 }],
        )
        .state
    }

    // --- basic lifecycle ---

    #[test]
    fn connect_then_open_lands_connected_and_reconciles() {
        let r1 = connection_reducer(&initial_connection_state(), &ConnectionEvent::ConnectRequested, CFG);
        assert_eq!(r1.state.status, S::Connecting);
        assert!(has(&r1.effects, |e| *e == ConnectionEffect::OpenSocket));

        let r2 = connection_reducer(&r1.state, &ConnectionEvent::SocketOpen { at: 42 }, CFG);
        assert_eq!(r2.state.status, S::Connected);
        assert_eq!(r2.state.attempt, 0);
        assert_eq!(r2.state.last_connected_at, Some(42));
        assert!(has(&r2.effects, |e| *e == ConnectionEffect::RefreshAndReconcile));
    }

    #[test]
    fn connect_while_connected_or_connecting_is_a_noop() {
        let s = connected_state();
        assert!(connection_reducer(&s, &ConnectionEvent::ConnectRequested, CFG).effects.is_empty());
    }

    #[test]
    fn disconnect_stops_everything_and_stays_inert() {
        let r = connection_reducer(&connected_state(), &ConnectionEvent::DisconnectRequested, CFG);
        assert_eq!(r.state.status, S::Stopped);
        assert!(has(&r.effects, |e| *e == ConnectionEffect::CloseSocket));
        let r2 = connection_reducer(&r.state, &ConnectionEvent::SocketClose { random: None }, CFG);
        assert!(r2.effects.is_empty());
        assert_eq!(r2.state.status, S::Stopped);
    }

    // --- backoff + jitter ---

    #[test]
    fn exponential_base_with_30s_cap() {
        let d = |a| backoff_delay_ms(a, 0.0, CFG);
        assert_eq!(d(0), RECONNECT_BASE_MS);
        assert_eq!(d(1), 4_000);
        assert_eq!(d(2), 8_000);
        assert_eq!(d(3), 16_000);
        assert_eq!(d(4), RECONNECT_MAX_MS);
        assert_eq!(d(50), RECONNECT_MAX_MS);
    }

    #[test]
    fn jitter_adds_at_most_25pct_never_negative() {
        for attempt in [0, 1, 2, 3, 4, 10] {
            let base = backoff_delay_ms(attempt, 0.0, CFG);
            let max_jitter = (base as f64 * RECONNECT_JITTER_FRACTION).floor() as u64;
            assert!(backoff_delay_ms(attempt, 1.0, CFG) <= base + max_jitter);
            assert!(backoff_delay_ms(attempt, 0.5, CFG) >= base);
            assert_eq!(backoff_delay_ms(attempt, -5.0, CFG), base);
            assert_eq!(backoff_delay_ms(attempt, 99.0, CFG), base + max_jitter);
        }
    }

    #[test]
    fn reconnect_storm_backs_off_monotonically_and_converges_at_the_cap() {
        let mut state = connected_state();
        let mut delays = Vec::new();
        for _ in 0..8 {
            let closed = connection_reducer(&state, &ConnectionEvent::SocketClose { random: Some(0.0) }, CFG);
            let retry = closed.effects.iter().find_map(|e| match e {
                ConnectionEffect::ScheduleRetry { delay_ms } => Some(*delay_ms),
                _ => None,
            });
            delays.push(retry.expect("schedule-retry"));
            let due = connection_reducer(&closed.state, &ConnectionEvent::RetryDue, CFG);
            assert_eq!(due.state.status, S::Connecting);
            state = due.state;
        }
        assert_eq!(delays, vec![2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000]);
        let opened = connection_reducer(&state, &ConnectionEvent::SocketOpen { at: 1 }, CFG);
        assert_eq!(opened.state.attempt, 0);
    }

    #[test]
    fn retry_due_while_offline_or_not_waiting_does_nothing() {
        assert!(connection_reducer(&initial_connection_state(), &ConnectionEvent::RetryDue, CFG).effects.is_empty());
        let closed = connection_reducer(&connected_state(), &ConnectionEvent::SocketClose { random: Some(0.0) }, CFG).state;
        let offline = connection_reducer(&closed, &ConnectionEvent::Offline, CFG).state;
        assert!(connection_reducer(&offline, &ConnectionEvent::RetryDue, CFG).effects.is_empty());
    }

    // --- network transitions ---

    #[test]
    fn offline_closes_and_cancels_online_reconnects_fresh() {
        let offline = connection_reducer(&connected_state(), &ConnectionEvent::Offline, CFG);
        assert_eq!(offline.state.status, S::Offline);
        assert!(has(&offline.effects, |e| *e == ConnectionEffect::CloseSocket));
        assert!(has(&offline.effects, |e| *e == ConnectionEffect::CancelRetry));

        let online = connection_reducer(&offline.state, &ConnectionEvent::Online, CFG);
        assert_eq!(online.state.status, S::Connecting);
        assert_eq!(online.state.attempt, 0);
        assert!(has(&online.effects, |e| *e == ConnectionEffect::OpenSocket));
    }

    #[test]
    fn socket_close_while_offline_waits_for_online_instead_of_burning_retries() {
        let mut state = connected_state();
        state.online = false; // OS event raced the socket close
        let r = connection_reducer(&state, &ConnectionEvent::SocketClose { random: None }, CFG);
        assert_eq!(r.state.status, S::Offline);
        assert!(!has(&r.effects, |e| matches!(e, ConnectionEffect::ScheduleRetry { .. })));
    }

    #[test]
    fn online_while_connected_is_a_noop() {
        let r = connection_reducer(&connected_state(), &ConnectionEvent::Online, CFG);
        assert!(r.effects.is_empty());
        assert_eq!(r.state.status, S::Connected);
    }

    // --- visibility ---

    #[test]
    fn going_hidden_only_schedules_the_debounce() {
        let r = connection_reducer(&connected_state(), &ConnectionEvent::Visibility { visible: false }, CFG);
        assert_eq!(r.state.status, S::Connected);
        assert_eq!(
            r.effects,
            vec![ConnectionEffect::ScheduleVisibilityCheck { delay_ms: VISIBILITY_DEBOUNCE_MS }]
        );
    }

    #[test]
    fn hidden_then_visible_within_debounce_cancels_cleanly() {
        let r = reduce(
            connected_state(),
            &[
                ConnectionEvent::Visibility { visible: false },
                ConnectionEvent::Visibility { visible: true },
            ],
        );
        assert_eq!(r.state.status, S::Connected);
        assert!(!r.state.hidden_pending);
        assert!(!has(&r.effects, |e| matches!(e, ConnectionEffect::CloseSocket | ConnectionEffect::OpenSocket)));
    }

    #[test]
    fn even_a_settled_hide_never_tears_down_a_healthy_socket() {
        let r = reduce(
            connected_state(),
            &[ConnectionEvent::Visibility { visible: false }, ConnectionEvent::VisibilitySettled],
        );
        assert_eq!(r.state.status, S::Connected);
        assert!(!r.state.visible);
        assert!(!has(&r.effects, |e| *e == ConnectionEffect::CloseSocket));
    }

    #[test]
    fn visibility_flip_storm_produces_no_socket_churn() {
        let mut state = connected_state();
        let mut all = Vec::new();
        for i in 0..20 {
            let r = connection_reducer(&state, &ConnectionEvent::Visibility { visible: i % 2 != 0 }, CFG);
            state = r.state;
            all.extend(r.effects);
        }
        assert_eq!(state.status, S::Connected);
        assert!(!all.iter().any(|e| matches!(e, ConnectionEffect::CloseSocket | ConnectionEffect::OpenSocket)));
    }

    #[test]
    fn becoming_visible_with_a_dead_connection_reconnects_immediately() {
        let closed = connection_reducer(&connected_state(), &ConnectionEvent::SocketClose { random: Some(0.0) }, CFG).state;
        let r = connection_reducer(&closed, &ConnectionEvent::Visibility { visible: true }, CFG);
        assert_eq!(r.state.status, S::Connecting);
        assert!(has(&r.effects, |e| *e == ConnectionEffect::OpenSocket));
        assert!(has(&r.effects, |e| *e == ConnectionEffect::CancelRetry));
    }

    // --- resume ---

    #[test]
    fn resume_while_connected_is_cheap_refresh_no_churn() {
        let r = connection_reducer(&connected_state(), &ConnectionEvent::Resume, CFG);
        assert_eq!(r.state.status, S::Connected);
        assert_eq!(r.effects, vec![ConnectionEffect::RefreshAndReconcile]);
    }

    #[test]
    fn resume_with_dead_connection_reconnects_fresh() {
        let closed = connection_reducer(&connected_state(), &ConnectionEvent::SocketClose { random: Some(0.0) }, CFG).state;
        let r = connection_reducer(&closed, &ConnectionEvent::Resume, CFG);
        assert_eq!(r.state.status, S::Connecting);
        assert_eq!(r.state.attempt, 0);
        assert!(has(&r.effects, |e| *e == ConnectionEffect::OpenSocket));
    }

    #[test]
    fn resume_while_offline_or_stopped_stays_put() {
        let offline = connection_reducer(&connected_state(), &ConnectionEvent::Offline, CFG).state;
        assert!(connection_reducer(&offline, &ConnectionEvent::Resume, CFG).effects.is_empty());
        let stopped = connection_reducer(&connected_state(), &ConnectionEvent::DisconnectRequested, CFG).state;
        assert!(connection_reducer(&stopped, &ConnectionEvent::Resume, CFG).effects.is_empty());
    }

    // --- decrypt failures ---

    #[test]
    fn decrypt_failures_count_and_raise_flag_but_never_disconnect() {
        let mut state = connected_state();
        for i in 1..=(DECRYPT_FAILURE_THRESHOLD + 2) {
            let r = connection_reducer(&state, &ConnectionEvent::DecryptFailure, CFG);
            assert!(r.effects.is_empty());
            state = r.state;
            assert_eq!(state.status, S::Connected);
            assert_eq!(state.decrypt_failures, i);
            assert_eq!(state.needs_pairing_check, i >= DECRYPT_FAILURE_THRESHOLD);
        }
    }

    // --- presence ---

    #[test]
    fn presence_socket_down_is_offline_regardless_of_heartbeat_age() {
        let mut state = connected_state();
        state = connection_reducer(&state, &ConnectionEvent::HeartbeatReceived { machine: "m1".into(), at: 1000 }, CFG).state;
        let closed = connection_reducer(&state, &ConnectionEvent::SocketClose { random: Some(0.0) }, CFG).state;
        assert_eq!(presence_of(&closed, "m1", 1001, HEARTBEAT_STALE_AFTER_MS), Presence::Offline);
    }

    #[test]
    fn presence_fresh_live_old_stale_unseen_offline() {
        let mut state = connected_state();
        state = connection_reducer(&state, &ConnectionEvent::HeartbeatReceived { machine: "m1".into(), at: 1000 }, CFG).state;
        assert_eq!(presence_of(&state, "m1", 1000 + HEARTBEAT_STALE_AFTER_MS, HEARTBEAT_STALE_AFTER_MS), Presence::Live);
        assert_eq!(presence_of(&state, "m1", 1001 + HEARTBEAT_STALE_AFTER_MS, HEARTBEAT_STALE_AFTER_MS), Presence::Stale);
        assert_eq!(presence_of(&state, "unknown", 1000, HEARTBEAT_STALE_AFTER_MS), Presence::Offline);
    }

    // --- heartbeats_all_stale (CDX-020) ---

    const STALE: u64 = HEARTBEAT_STALE_AFTER_MS;

    fn connected_with_beat() -> ConnectionState {
        reduce(
            initial_connection_state(),
            &[
                ConnectionEvent::ConnectRequested,
                ConnectionEvent::SocketOpen { at: 0 },
                ConnectionEvent::HeartbeatReceived { machine: "m1".into(), at: 0 },
            ],
        )
        .state
    }

    #[test]
    fn all_stale_while_connected_past_grace_is_true() {
        assert!(heartbeats_all_stale(&connected_with_beat(), STALE + 1, STALE));
    }

    #[test]
    fn one_fresh_heartbeat_keeps_it_false() {
        let mut state = connected_with_beat();
        state = connection_reducer(&state, &ConnectionEvent::HeartbeatReceived { machine: "m2".into(), at: STALE }, CFG).state;
        assert!(!heartbeats_all_stale(&state, STALE + 1, STALE));
    }

    #[test]
    fn no_machine_ever_heartbeated_is_false() {
        let state = reduce(
            initial_connection_state(),
            &[ConnectionEvent::ConnectRequested, ConnectionEvent::SocketOpen { at: 0 }],
        )
        .state;
        assert!(!heartbeats_all_stale(&state, STALE * 10, STALE));
    }

    #[test]
    fn never_true_in_any_non_connected_status() {
        let base = connected_with_beat();
        let closed = connection_reducer(&base, &ConnectionEvent::SocketClose { random: Some(0.0) }, CFG).state;
        let offline = connection_reducer(&base, &ConnectionEvent::Offline, CFG).state;
        let stopped = connection_reducer(&base, &ConnectionEvent::DisconnectRequested, CFG).state;
        for state in [initial_connection_state(), closed, offline, stopped] {
            assert!(!heartbeats_all_stale(&state, STALE * 10, STALE));
        }
    }

    #[test]
    fn fresh_reconnect_gets_a_full_stale_window_of_grace() {
        let mut state = connected_with_beat();
        state = connection_reducer(&state, &ConnectionEvent::SocketClose { random: Some(0.0) }, CFG).state;
        state = connection_reducer(&state, &ConnectionEvent::RetryDue, CFG).state;
        state = connection_reducer(&state, &ConnectionEvent::SocketOpen { at: STALE + 5 }, CFG).state;
        assert!(!heartbeats_all_stale(&state, STALE + 6, STALE)); // within grace
        assert!(heartbeats_all_stale(&state, 2 * STALE + 6, STALE)); // a window later, still nothing
    }
}
