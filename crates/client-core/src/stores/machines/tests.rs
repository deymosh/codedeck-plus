use super::*;
use protocol::capabilities::PROTOCOL_VERSION;
use protocol::common::{
    AgentAccount, AvailablePlugin, InstalledPlugin, McpServerInfo, PermissionRule, Persona, ProviderProfileInfo,
    SessionMcpServer, SignInAttempt,
};
use protocol::events::{ModelEntry, SlashCommand};
use protocol::codec::decode_bridge_to_phone;
use protocol::events::BridgeToPhone;
use serde_json::json;

fn info(id: &str) -> RemoteSessionInfo {
    RemoteSessionInfo {
        id: id.into(),
        agent: "claude-code".into(),
        slug: format!("slug-{id}"),
        cwd: "/work".into(),
        last_activity: "1970-01-01T00:00:00.000Z".into(),
        line_count: 0,
        title: None,
        project: "proj".into(),
        mode: None,
        effort: None,
        model: None,
        persona: None,
        context_window: None,
        context_percentage: None,
        committed: None,
        state: None,
        seq_high: None,
        provider_id: None,
        provider_label: None,
        turn_started_at: None,
    }
}

fn titled(id: &str, title: &str) -> RemoteSessionInfo {
    RemoteSessionInfo {
        title: Some(title.into()),
        ..info(id)
    }
}

/// Build a `sessions` message by round-tripping through the real decoder —
/// keeps the test honest against the wire schema.
fn list(sessions: &[RemoteSessionInfo], extra: serde_json::Value) -> SessionListMsg {
    let mut obj = json!({
        "v": 12,
        "type": "sessions",
        "machine": "m1",
        "sessions": sessions,
        "agents": [],
        "v": protocol::capabilities::PROTOCOL_VERSION,
    });
    if let (Some(o), Some(e)) = (obj.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            o.insert(k.clone(), v.clone());
        }
    }
    match decode_bridge_to_phone(&obj.to_string()).unwrap() {
        BridgeToPhone::Sessions(m) => m,
        other => panic!("not a sessions message: {other:?}"),
    }
}

fn view(id: &str, presence: ListingPresence, last_listed_at: u64) -> SessionView {
    SessionView {
        info: info(id),
        presence,
        last_listed_at,
        usage: None,
        commands: None,
        mcp: None,
        personas: None,
    }
}

fn map(views: Vec<SessionView>) -> BTreeMap<String, SessionView> {
    views.into_iter().map(|v| (v.info.id.clone(), v)).collect()
}

const NONE: fn() -> serde_json::Value = || json!({});

#[test]
fn an_incompatible_bridge_is_marked_until_it_is_read_and_never_persisted() {
    let mut st = MachinesState::default();
    st.machines.insert("pk".into(), MachineView::new("pk".into(), "m".into()));
    let next = u64::from(PROTOCOL_VERSION) + 1;
    assert!(Incompatible { theirs: Some(next), at: 0 }.app_is_older());
    assert!(!Incompatible { theirs: None, at: 0 }.app_is_older());
    assert!(!Incompatible { theirs: Some(10), at: 0 }.app_is_older());
    let mark = |st: &MachinesState| st.machine("pk").unwrap().incompatible.map(|i| i.theirs);

    assert!(!st.note_read("pk", 100));
    // A relay replaying a message from before the last one read.
    assert!(!st.note_unreadable("pk", None, 90));
    assert_eq!(mark(&st), None);

    assert!(st.note_unreadable("pk", Some(next), 110));
    assert!(!st.note_unreadable("pk", Some(next), 120), "no change, nothing to tell");
    assert_eq!(mark(&st), Some(Some(next)));
    assert!(!serialize_machines(&st.machines).contains("incompatible"));
    // An older readable message does not take the mark away; a newer one does.
    assert!(!st.note_read("pk", 115));
    assert!(st.note_read("pk", 120));
    assert_eq!(mark(&st), None);
    assert!(!st.note_unreadable("nobody", None, 200));
}

#[test]
fn upserts_listed_sessions_as_live() {
    let next = merge_session_list(
        &BTreeMap::new(),
        &list(&[info("a"), info("b")], NONE()),
        100,
        MergeOptions::default(),
    );
    assert_eq!(next.keys().cloned().collect::<Vec<_>>(), vec!["a", "b"]);
    assert_eq!(next["a"].presence, ListingPresence::Live);
    assert_eq!(next["a"].last_listed_at, 100);
}

#[test]
fn absence_never_deletes_a_missing_session_goes_stale() {
    let prev = map(vec![
        view("a", ListingPresence::Live, 0),
        view("b", ListingPresence::Live, 0),
    ]);
    let next = merge_session_list(&prev, &list(&[info("a")], NONE()), 100, MergeOptions::default());
    assert_eq!(next["b"].presence, ListingPresence::Stale);
    assert_eq!(next["a"].presence, ListingPresence::Live);
}

#[test]
fn an_empty_incoming_list_deletes_nothing() {
    let prev = map(vec![
        view("a", ListingPresence::Live, 0),
        view("b", ListingPresence::Live, 0),
        view("c", ListingPresence::Live, 0),
    ]);
    let next = merge_session_list(&prev, &list(&[], NONE()), 100, MergeOptions::default());
    assert_eq!(next.len(), 3);
    assert!(next.values().all(|v| v.presence == ListingPresence::Stale));
}

#[test]
fn tombstones_are_the_only_bridge_removal_and_only_hit_their_target() {
    let prev = map(vec![
        view("a", ListingPresence::Live, 0),
        view("b", ListingPresence::Live, 0),
    ]);
    let next = merge_session_list(
        &prev,
        &list(&[info("a")], json!({ "removedSessions": ["b"] })),
        100,
        MergeOptions::default(),
    );
    assert!(!next.contains_key("b"));
    assert!(next.contains_key("a"));
}

#[test]
fn a_tombstone_for_an_unknown_session_is_harmless() {
    let next = merge_session_list(
        &map(vec![view("a", ListingPresence::Live, 0)]),
        &list(&[info("a")], json!({ "removedSessions": ["ghost"] })),
        100,
        MergeOptions::default(),
    );
    assert_eq!(next.keys().cloned().collect::<Vec<_>>(), vec!["a"]);
}

#[test]
fn machine_offline_keeps_every_session_marked_offline() {
    let prev = map(vec![
        view("a", ListingPresence::Live, 0),
        view("b", ListingPresence::Live, 0),
    ]);
    let next = merge_session_list(
        &prev,
        &list(&[info("a")], json!({ "machineOffline": true })),
        100,
        MergeOptions::default(),
    );
    assert_eq!(next.len(), 2);
    assert_eq!(next["a"].presence, ListingPresence::Offline);
    assert_eq!(next["b"].presence, ListingPresence::Offline);
}

#[test]
fn grace_period_holds_a_recent_absentee_and_stales_an_old_one() {
    let prev = map(vec![
        view("fresh", ListingPresence::Live, 95),
        view("old", ListingPresence::Live, 10),
    ]);
    let next = merge_session_list(&prev, &list(&[], NONE()), 100, MergeOptions { stale_grace_ms: 10 });
    assert_eq!(next["fresh"].presence, ListingPresence::Live);
    assert_eq!(next["old"].presence, ListingPresence::Stale);
}

#[test]
fn merge_does_not_mutate_prev() {
    let prev = map(vec![view("a", ListingPresence::Live, 0)]);
    let snapshot = prev.clone();
    let _ = merge_session_list(
        &prev,
        &list(&[], json!({ "removedSessions": ["a"] })),
        100,
        MergeOptions::default(),
    );
    assert_eq!(prev, snapshot);
}

// --- title merge guard ---

#[test]
fn a_titleless_incoming_session_keeps_the_held_title() {
    let prev = map(vec![SessionView {
        info: titled("s1", "client stopgap"),
        ..view("s1", ListingPresence::Live, 0)
    }]);
    let next = merge_session_list(&prev, &list(&[info("s1")], NONE()), 1, MergeOptions::default());
    assert_eq!(next["s1"].info.title.as_deref(), Some("client stopgap"));
}

#[test]
fn a_non_null_incoming_title_always_wins() {
    let prev = map(vec![SessionView {
        info: titled("s1", "client stopgap"),
        ..view("s1", ListingPresence::Live, 0)
    }]);
    let next = merge_session_list(
        &prev,
        &list(&[titled("s1", "bridge topical")], NONE()),
        1,
        MergeOptions::default(),
    );
    assert_eq!(next["s1"].info.title.as_deref(), Some("bridge topical"));
}

#[test]
fn no_previous_title_incoming_null_stays_null() {
    let next = merge_session_list(
        &map(vec![view("s1", ListingPresence::Live, 0)]),
        &list(&[info("s1")], NONE()),
        1,
        MergeOptions::default(),
    );
    assert_eq!(next["s1"].info.title, None);
}

#[test]
fn per_session_usage_survives_a_heartbeat() {
    let usage: UsageData = serde_json::from_value(json!({
        "available": true,
        "subscriptionType": null,
        "fiveHour": { "utilization": 0.2, "resetsAt": null },
        "fetchedAt": "1970-01-01T00:00:00.000Z"
    }))
    .unwrap();
    let prev = map(vec![SessionView {
        usage: Some(usage.clone()),
        ..view("s1", ListingPresence::Live, 0)
    }]);
    let next = merge_session_list(&prev, &list(&[info("s1")], NONE()), 5, MergeOptions::default());
    assert_eq!(next["s1"].usage, Some(usage));
}

// --- title_from_first_message ---

#[test]
fn title_from_first_message_truncation_is_exact() {
    let eighty = "a".repeat(80);
    assert_eq!(title_from_first_message(&eighty), eighty);
    let eighty_one = "b".repeat(81);
    assert_eq!(title_from_first_message(&eighty_one), format!("{}...", "b".repeat(77)));
    assert_eq!(title_from_first_message(&eighty_one).chars().count(), 80);
    assert_eq!(title_from_first_message("line1\nline2\n line3 "), "line1 line2  line3");
    assert_eq!(title_from_first_message("  \n \n "), "");
}

// --- dismissed sessions ---

#[test]
fn a_dismissal_ends_once_its_bridge_has_not_listed_it_for_a_while() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[info("a")], NONE()), 1);
    st.user_remove_session("pk", "a");
    st.dismiss_session("pk", "a", 1_000);
    // Dropped by the bridge: still dismissed through the resume window.
    st.apply_session_list("pk", &list(&[], NONE()), 1_000 + protocol::direct::OUTBOX_SECS * 1000);
    assert!(st.is_dismissed("a"));
    st.apply_session_list("pk", &list(&[], NONE()), 1_000 + DISMISSED_TTL_MS);
    assert!(!st.is_dismissed("a"));
    assert!(!st.is_dismissed("other"));
}

#[test]
fn a_bridge_back_after_a_long_absence_does_not_bring_a_deleted_session_back() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[info("a")], NONE()), 1);
    st.user_remove_session("pk", "a");
    st.dismiss_session("pk", "a", 1_000);
    // No heartbeat for a day: by the bridge's heartbeats no time passed.
    let day = 24 * 3600 * 1000;
    st.apply_session_list("other", &list(&[], NONE()), day);
    assert!(st.is_dismissed("a"));
    // It comes back still listing it: still hidden, and the close is due.
    assert_eq!(st.apply_session_list("pk", &list(&[info("a")], NONE()), day + 1), ["a"]);
    assert!(st.session("pk", "a").is_none());
}

#[test]
fn a_close_is_sent_again_while_the_bridge_lists_the_session_until_it_acks() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[info("a")], NONE()), 1);
    st.user_remove_session("pk", "a");
    st.dismiss_session("pk", "a", 1_000);
    st.note_close_sent("a", 1_000);
    let unclosed = st.apply_session_list("pk", &list(&[info("a")], NONE()), 2_000);
    assert!(st.closes_due(&unclosed, 2_000).is_empty(), "not again right away");
    let unclosed = st.apply_session_list("pk", &list(&[info("a")], NONE()), 1_000 + CLOSE_RETRY_MS);
    assert_eq!(st.closes_due(&unclosed, 1_000 + CLOSE_RETRY_MS), ["a"]);
    // Acknowledged: never sent again, and still kept out.
    st.note_closed("a");
    assert!(st.apply_session_list("pk", &list(&[info("a")], NONE()), 3 * CLOSE_RETRY_MS).is_empty());
    assert!(st.session("pk", "a").is_none());
}

#[test]
fn removing_a_machine_forgets_the_sessions_deleted_on_it() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[info("a")], NONE()), 1);
    st.user_remove_session("pk", "a");
    st.dismiss_session("pk", "a", 1_000);
    st.remove_machine("pk");
    assert!(!st.is_dismissed("a"));
}

#[test]
fn dismissed_sessions_round_trip_and_garbage_is_empty() {
    let d: BTreeMap<String, Dismissed> =
        [("s".to_string(), Dismissed { machine: "pk".into(), at: 42, closed: true })].into_iter().collect();
    assert_eq!(hydrate_dismissed(Some(&serialize_dismissed(&d))), d);
    assert!(hydrate_dismissed(Some("[not a map")).is_empty());
    assert!(hydrate_dismissed(None).is_empty());
    // An entry it cannot read is skipped, not the whole map.
    let mixed = r#"{"old":42,"s":{"machine":"pk","at":42,"closed":true}}"#;
    assert_eq!(hydrate_dismissed(Some(mixed)), d);
}

// --- property: sessions are lost ONLY to tombstones ---

fn prng(seed: u32) -> impl FnMut() -> f64 {
    let mut s = seed;
    move || {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(s) / f64::from(u32::MAX)
    }
}

// --- MachinesState (store transforms) ---

fn models_msg(ids: &[&str], default: Option<&str>) -> ModelsMsg {
    ModelsMsg {
        agent: "claude-code".into(),
        models: ids
            .iter()
            .map(|id| ModelEntry {
                id: (*id).to_string(),
                label: Some(id.to_uppercase()),
                ..Default::default()
            })
            .collect(),
        default_model: default.map(str::to_string),
        error: None,
    }
}

fn agent_models<'a>(st: &'a MachinesState, agent: &str) -> &'a AgentModels {
    st.machine("pk").unwrap().models.get(agent).expect("agent entry")
}

#[test]
fn apply_session_list_creates_the_machine_and_keeps_it_across_heartbeats() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[info("s1")], NONE()), 10);
    st.apply_models("pk", &models_msg(&["opus", "sonnet"], Some("opus")));
    assert_eq!(agent_models(&st, "claude-code").models.as_ref().unwrap().len(), 2);

    // CDX-022: the refresh-sessions heartbeat that used to wipe the picker.
    for at in [20, 30, 40, 50, 60] {
        st.apply_session_list("pk", &list(&[info("s1")], NONE()), at);
    }
    let kept = agent_models(&st, "claude-code");
    assert_eq!(
        kept.models.as_ref().unwrap().iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["opus", "sonnet"]
    );
    assert_eq!(kept.default_model.as_deref(), Some("opus"));
}

#[test]
fn a_heartbeat_replaces_the_agent_catalog_and_bridge_credentials() {
    let mut st = MachinesState::default();
    st.apply_session_list(
        "pk",
        &list(
            &[],
            json!({
                "agents": [{ "id": "claude-code", "displayName": "Claude Code", "supports": { "models": true } }],
                "credentials": [{ "id": "github_pat", "label": "GitHub token", "present": true }],
            }),
        ),
        10,
    );
    let m = st.machine("pk").unwrap();
    assert!(m.agent("claude-code").unwrap().supports.models);
    assert!(m.agent("opencode").is_none());
    assert!(m.credentials[0].present);

    st.apply_session_list("pk", &list(&[], json!({ "agents": [{ "id": "opencode", "displayName": "OpenCode" }] })), 20);
    let m = st.machine("pk").unwrap();
    assert!(m.agent("claude-code").is_none());
    assert!(m.agent("opencode").is_some());
    assert!(m.credentials.is_empty());
}

#[test]
fn a_style_is_wanted_until_its_hash_is_cached_and_shared_across_machines() {
    let style = protocol::common::AgentStyle { accent: Some("#D77757".into()), ..Default::default() };
    let hash = style.hash();
    let catalog = json!({ "agents": [
        { "id": "claude-code", "displayName": "Claude Code", "styleHash": hash },
        { "id": "opencode", "displayName": "OpenCode" },
    ] });
    let mut opencode = info("s2");
    opencode.agent = "opencode".into();
    let mut st = MachinesState::default();
    st.apply_session_list("a", &list(&[info("s1"), opencode], catalog.clone()), 10);
    st.apply_session_list("b", &list(&[info("s3")], catalog), 10);

    assert_eq!(st.missing_style("a", "s1").as_deref(), Some("claude-code"));
    assert_eq!(st.missing_style("a", "s2"), None, "an agent with no style");
    assert_eq!(st.missing_style("a", "nope"), None);

    let answer = |hash: Option<String>| AgentStyleMsg { agent: "claude-code".into(), style_hash: hash, style: Some(style.clone()) };
    assert!(!st.apply_agent_style(&answer(Some("0123456789abcdef".into()))), "not the style's hash");
    assert!(!st.apply_agent_style(&answer(None)));
    assert!(st.apply_agent_style(&answer(Some(hash.clone()))));
    assert_eq!(st.missing_style("a", "s1"), None);
    assert_eq!(st.missing_style("b", "s3"), None, "the same hash on another bridge");
    assert_eq!(st.agent_styles.get(&hash), Some(&style));
}

#[test]
fn an_empty_models_response_never_wipes_a_good_list_and_carries_the_reason() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[], NONE()), 10);
    st.apply_models("pk", &models_msg(&["opus"], None));
    st.apply_models(
        "pk",
        &ModelsMsg {
            agent: "claude-code".into(),
            models: vec![],
            default_model: None,
            error: Some("no live SDK".into()),
        },
    );
    assert_eq!(agent_models(&st, "claude-code").models.as_ref().unwrap()[0].id, "opus");
    assert_eq!(agent_models(&st, "claude-code").error.as_deref(), Some("no live SDK"));
    // a later good answer clears the error
    st.apply_models("pk", &models_msg(&["opus", "sonnet"], None));
    assert_eq!(agent_models(&st, "claude-code").error, None);
}

#[test]
fn session_commands_keep_the_held_list_on_an_error_and_are_never_persisted() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[info("s1")], NONE()), 10);
    let cmd = |name: &str| SlashCommand { name: name.into(), description: None, argument_hint: None };
    let msg = |commands: Vec<SlashCommand>, error: Option<&str>| CommandsMsg {
        session_id: "s1".into(),
        commands,
        error: error.map(str::to_string),
    };
    let held = |st: &MachinesState| st.machine("pk").unwrap().sessions["s1"].commands.clone().unwrap();

    st.apply_commands("pk", &msg(vec![cmd("compact")], None));
    st.apply_commands("pk", &msg(vec![], Some("not running")));
    assert_eq!(held(&st), SessionCommands { commands: vec![cmd("compact")], error: Some("not running".into()) });
    st.apply_commands("pk", &msg(vec![cmd("init")], None));
    assert_eq!(held(&st), SessionCommands { commands: vec![cmd("init")], error: None });

    // Survives a heartbeat, but not a restart.
    st.apply_session_list("pk", &list(&[info("s1")], NONE()), 20);
    assert_eq!(held(&st).commands, vec![cmd("init")]);
    let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
    assert_eq!(back["pk"].sessions["s1"].commands, None);
}

#[test]
fn personas_land_on_their_session_or_the_machine_and_are_never_persisted() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[info("s1")], NONE()), 10);
    let persona = |id: &str| Persona { id: id.into(), label: id.into(), description: None, color: None };
    let msg = |session: Option<&str>, personas: Vec<Persona>, error: Option<&str>| PersonasMsg {
        agent: "opencode".into(),
        session_id: session.map(str::to_string),
        personas,
        error: error.map(str::to_string),
    };
    let session = |st: &MachinesState| st.machine("pk").unwrap().sessions["s1"].personas.clone().unwrap();
    let machine = |st: &MachinesState| st.machine("pk").unwrap().personas["opencode"].clone();

    st.apply_personas("pk", &msg(Some("s1"), vec![persona("build"), persona("review")], None));
    st.apply_personas("pk", &msg(None, vec![persona("build")], None));
    assert_eq!(session(&st).personas.len(), 2);
    assert_eq!(machine(&st).personas, vec![persona("build")]);
    // An empty answer keeps what was held, with the reason.
    st.apply_personas("pk", &msg(Some("s1"), vec![], Some("not running")));
    assert_eq!(session(&st), PersonaList { personas: vec![persona("build"), persona("review")], error: Some("not running".into()) });
    // A session the phone does not know is no machine-wide list.
    st.apply_personas("pk", &msg(Some("gone"), vec![persona("x")], None));
    assert_eq!(machine(&st).personas, vec![persona("build")]);

    st.apply_session_list("pk", &list(&[info("s1")], NONE()), 20);
    assert_eq!(session(&st).personas.len(), 2);
    let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
    assert_eq!(back["pk"].sessions["s1"].personas, None);
    assert!(back["pk"].personas.is_empty());
}

#[test]
fn an_agent_action_is_busy_until_acknowledged_and_never_persisted() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    let held = |st: &MachinesState| st.machine("pk").unwrap().agent_actions["opencode"].clone();
    let ack = |success: bool, error: Option<&str>| AgentAckMsg {
        agent: "opencode".into(),
        action: AgentAction::Remove,
        success,
        error: error.map(str::to_string),
    };

    st.agent_action_sent("pk", "opencode", AgentAction::Remove, 0);
    assert_eq!(held(&st).busy, Some(AgentAction::Remove));
    assert!(serialize_machines(&st.machines).find("agentActions").is_none());
    st.apply_agent_ack("pk", &ack(false, Some("not removable")));
    assert_eq!(held(&st), AgentActionState { busy: None, failure: Some("not removable".into()) });
    st.agent_action_sent("pk", "opencode", AgentAction::Install, 0);
    assert_eq!(held(&st).failure, None, "a new action clears the last refusal");
    st.apply_agent_ack("pk", &ack(true, None));
    assert_eq!(held(&st), AgentActionState::default());
}

#[test]
fn accounts_follow_a_sign_in_keep_their_list_on_errors_and_are_never_persisted() {
    use protocol::common::AccountConnection;
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    let account = |id: &str, connected: bool| AgentAccount {
        id: id.into(),
        name: id.into(),
        methods: vec![],
        connections: if connected {
            vec![AccountConnection { id: "c".into(), label: "l".into(), kind: "key".into(), active: true, removable: true }]
        } else {
            vec![]
        },
    };
    let list = |accounts: Vec<AgentAccount>, all: bool, error: Option<&str>| AccountsMsg {
        agent: "opencode".into(),
        accounts,
        all,
        error: error.map(Into::into),
    };
    let held = |st: &MachinesState| st.machine("pk").unwrap().accounts["opencode"].clone();

    st.apply_accounts("pk", &list(vec![account("a", true), account("b", false)], true, None));
    assert_eq!(held(&st).connected.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["a"]);
    assert_eq!(held(&st).all.as_ref().map(Vec::len), Some(2));

    // A sign-in: followed from the moment it is asked, its attempt kept
    // until it ends; an answer about another attempt is not shown.
    st.account_action_sent("pk", "opencode", "b", true, 0);
    assert_eq!(held(&st).busy, ["b"]);
    let attempt = SignInAttempt {
        attempt_id: "con_1".into(),
        url: "https://x".into(),
        instructions: "Enter code: X".into(),
        expires_at: 1,
        paste_back: false,
    };
    let sign_in = |status, id: &str, attempt: Option<SignInAttempt>| AccountSignInMsg {
        agent: "opencode".into(),
        account: "b".into(),
        status,
        attempt_id: Some(id.into()),
        attempt,
        error: None,
    };
    st.apply_account_sign_in("pk", &sign_in(SignInStatus::Started, "con_1", Some(attempt.clone())));
    st.apply_account_sign_in("pk", &sign_in(SignInStatus::Failed, "con_0", None));
    assert_eq!(held(&st).sign_in.unwrap().status, SignInStatus::Started);
    st.apply_account_sign_in("pk", &sign_in(SignInStatus::Complete, "con_1", None));
    let view = held(&st).sign_in.unwrap();
    assert_eq!((view.status, view.attempt), (SignInStatus::Complete, Some(attempt)));
    assert!(held(&st).busy.is_empty());

    // A connected list after a change keeps the catalogue in step; a
    // failure keeps both.
    st.apply_accounts("pk", &list(vec![account("a", true), account("b", true)], false, None));
    assert_eq!(held(&st).all.unwrap().iter().filter(|x| !x.connections.is_empty()).count(), 2);
    st.apply_accounts("pk", &list(vec![], false, Some("no opencode")));
    assert_eq!(held(&st).connected.len(), 2);
    assert_eq!(held(&st).error.as_deref(), Some("no opencode"));

    st.dismiss_sign_in("pk", "opencode");
    assert!(held(&st).sign_in.is_none());
    let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
    assert!(back["pk"].accounts.is_empty());
}

#[test]
fn permission_rules_track_removals_keep_their_list_on_errors_and_are_never_persisted() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    let rule = |id: &str| PermissionRule {
        id: id.into(),
        project: "/w".into(),
        tool: "shell".into(),
        pattern: "git status *".into(),
        created_at: 1,
    };
    let msg = |rules: Vec<PermissionRule>, error: Option<&str>| PermissionRulesMsg {
        agent: "opencode".into(),
        rules,
        error: error.map(Into::into),
    };
    let held = |st: &MachinesState| st.machine("pk").unwrap().permission_rules["opencode"].clone();

    st.apply_permission_rules("pk", &msg(vec![rule("a"), rule("b")], None));
    st.permission_rules_remove_sent("pk", "opencode", &["a".to_string()], 0);
    assert_eq!(held(&st).busy, ["a"]);
    // A refused removal keeps the list and says why; nothing stays busy.
    st.apply_permission_rules("pk", &msg(vec![], Some("database is locked")));
    assert_eq!(held(&st).rules.len(), 2);
    assert_eq!(held(&st).error.as_deref(), Some("database is locked"));
    assert!(held(&st).busy.is_empty());
    // The list after a removal replaces it and clears the error.
    st.apply_permission_rules("pk", &msg(vec![rule("b")], None));
    assert_eq!(held(&st), AgentPermissionRules { rules: vec![rule("b")], error: None, busy: vec![] });

    let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
    assert!(back["pk"].permission_rules.is_empty());
}

#[test]
fn mcp_servers_track_changes_in_flight_keep_their_list_on_errors_and_are_never_persisted() {
    use protocol::common::{McpStatus, McpTransportKind};
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    st.apply_session_upsert("pk", &info("s1"), 0);
    let server = |name: &str| McpServerInfo {
        name: name.into(),
        transport: McpTransportKind::Http,
        target: "https://x".into(),
        env_keys: vec![],
        header_keys: vec!["Authorization".into()],
        enabled: true,
    };
    let list = |servers: Vec<McpServerInfo>, error: Option<&str>| McpServersMsg {
        agent: "claude-code".into(),
        servers,
        toggles: false,
        error: error.map(str::to_string),
    };
    let held = |st: &MachinesState| st.machine("pk").unwrap().mcp["claude-code"].clone();

    st.apply_mcp("pk", &list(vec![server("gh")], None));
    st.mcp_action_sent("pk", "claude-code", McpAction::Add, &["fs".to_string()], 0);
    assert_eq!(held(&st).busy, ["fs"]);
    st.apply_mcp_ack("pk", &McpAckMsg {
        agent: "claude-code".into(),
        action: McpAction::Add,
        names: vec!["fs".into()],
        success: false,
        error: Some("bad".into()),
    });
    assert!(held(&st).busy.is_empty());
    assert_eq!(held(&st).failure.unwrap().error, "bad");
    st.apply_mcp("pk", &list(vec![], Some("no claude")));
    assert_eq!(held(&st).servers, vec![server("gh")], "the held list stays");

    let status = |status: McpStatus, error: Option<&str>| SessionMcpMsg {
        session_id: "s1".into(),
        servers: if error.is_some() { vec![] } else { vec![SessionMcpServer { name: "gh".into(), status, error: None, tools: None }] },
        toggles: true,
        project_wide: false,
        error: error.map(str::to_string),
    };
    st.apply_session_mcp("pk", &status(McpStatus::Connected, None));
    st.session_mcp_toggle_sent("pk", "s1", "gh", 0);
    let session = |st: &MachinesState| st.machine("pk").unwrap().sessions["s1"].mcp.clone().unwrap();
    assert_eq!(session(&st).busy, ["gh"]);
    st.apply_session_mcp("pk", &status(McpStatus::Disabled, Some("refused")));
    assert!(session(&st).busy.is_empty());
    assert_eq!(session(&st).servers[0].status, McpStatus::Connected, "kept on an error");

    let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
    assert!(back["pk"].mcp.is_empty());
    assert_eq!(back["pk"].sessions["s1"].mcp, None);
}

#[test]
fn plugins_track_changes_in_flight_and_are_never_persisted() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[], NONE()), 10);
    let installed = |id: &str| InstalledPlugin {
        id: id.into(),
        name: id.into(),
        marketplace: None,
        version: None,
        description: None,
        enabled: true,
    };
    let offer = |id: &str| AvailablePlugin {
        id: id.into(),
        name: id.into(),
        marketplace: "m".into(),
        description: None,
        install_count: None,
    };
    let msg = |installed: Vec<InstalledPlugin>, available: Option<Vec<AvailablePlugin>>, error: Option<&str>| PluginsMsg {
        agent: "claude-code".into(),
        installed,
        marketplaces: Some(vec![]),
        toggles: true,
        install_hint: None,
        install_note: None,
        available,
        error: error.map(str::to_string),
    };
    let held = |st: &MachinesState| st.machine("pk").unwrap().plugins["claude-code"].clone();

    st.apply_plugins("pk", &msg(vec![installed("a@m")], Some(vec![offer("b@m"), offer("c@m")]), None));
    st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 0);
    assert_eq!(held(&st).busy, vec!["b@m".to_string()]);

    // Installed: acknowledged, then the new list without the offer.
    let ack = |success: bool| PluginAckMsg {
        agent: "claude-code".into(),
        action: PluginAction::Install,
        target: "b@m".into(),
        success,
        error: (!success).then(|| "not found".into()),
        message: None,
    };
    st.apply_plugin_ack("pk", &ack(true));
    st.apply_plugins("pk", &msg(vec![installed("a@m"), installed("b@m")], None, None));
    let p = held(&st);
    assert!(p.busy.is_empty() && p.failure.is_none());
    assert_eq!(p.available.unwrap().iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["c@m"]);

    // A success with something to say keeps it; the next change sent
    // clears it, and a failure leaves nothing.
    let mut said = ack(true);
    said.message = Some("Updated from 0.1.0 to 0.2.0.".into());
    st.apply_plugin_ack("pk", &said);
    assert_eq!(held(&st).notice.as_ref().map(|n| n.message.as_str()), Some("Updated from 0.1.0 to 0.2.0."));
    st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 0);
    assert_eq!(held(&st).notice, None);
    st.apply_plugin_ack("pk", &ack(false));
    assert_eq!(held(&st).notice, None);

    st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 0);
    st.apply_plugin_ack("pk", &ack(false));
    assert_eq!(held(&st).failure.map(|f| f.error), Some("not found".into()));

    // A failed read keeps what is held.
    st.apply_plugins("pk", &msg(vec![], None, Some("no claude")));
    assert_eq!((held(&st).installed.len(), held(&st).error), (2, Some("no claude".into())));

    // The driver's install wording is replaced by each list, exactly like
    // the rest of the state; a list without it clears what was held.
    st.apply_plugins("pk", &PluginsMsg {
        agent: "claude-code".into(),
        installed: vec![],
        marketplaces: None,
        toggles: false,
        install_hint: Some("npm package name".into()),
        install_note: Some("Installed from npm; sessions pick it up at their next start.".into()),
        available: None,
        error: None,
    });
    let p = held(&st);
    assert_eq!(p.install_hint.as_deref(), Some("npm package name"));
    assert_eq!(p.install_note.as_deref(), Some("Installed from npm; sessions pick it up at their next start."));
    st.apply_plugins("pk", &msg(vec![], None, None));
    assert_eq!((held(&st).install_hint, held(&st).install_note), (None, None));

    let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
    assert!(back["pk"].plugins.is_empty());
}

#[test]
fn a_machine_settings_change_nobody_answers_settles_at_the_timeout() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    st.apply_session_upsert("pk", &info("s1"), 0);
    let t = 1_000;
    let done = t + SETTINGS_ANSWER_TIMEOUT_MS;

    // One change of every kind, all sent at the same instant.
    st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", t);
    st.agent_action_sent("pk", "opencode", AgentAction::Install, t);
    st.mcp_action_sent("pk", "claude-code", McpAction::Add, &["fs".to_string()], t);
    st.permission_rules_remove_sent("pk", "opencode", &["r1".to_string()], t);
    st.account_action_sent("pk", "opencode", "a", true, t);
    st.apply_session_mcp(
        "pk",
        &SessionMcpMsg { session_id: "s1".into(), servers: vec![], toggles: true, project_wide: false, error: None },
    );
    st.session_mcp_toggle_sent("pk", "s1", "gh", t);

    // Not before the deadline: everything is still in flight.
    assert!(!st.expire_unanswered(done - 1));
    let m = st.machine("pk").unwrap();
    assert!(m.plugins["claude-code"].busy.contains(&"b@m".to_string()));
    assert!(m.agent_actions["opencode"].busy.is_some());
    assert!(m.mcp["claude-code"].busy.contains(&"fs".to_string()));
    assert!(m.permission_rules["opencode"].busy.contains(&"r1".to_string()));
    assert!(m.accounts["opencode"].busy.contains(&"a".to_string()));
    assert!(m.sessions["s1"].mcp.as_ref().unwrap().busy.contains(&"gh".to_string()));

    // At the deadline each settles and says why — but the plugin change,
    // which the bridge answers only once the install is done, keeps
    // waiting until its own, longer one.
    assert!(st.expire_unanswered(done));
    let m = st.machine("pk").unwrap();
    assert!(m.plugins["claude-code"].busy.contains(&"b@m".to_string()));
    assert!(m.agent_actions["opencode"].busy.is_none());
    assert_eq!(m.agent_actions["opencode"].failure.as_deref(), Some(NO_ANSWER));
    let mcp = &m.mcp["claude-code"];
    assert!(mcp.busy.is_empty());
    assert_eq!(mcp.failure.as_ref().map(|f| (f.names.clone(), f.error.as_str())), Some((vec!["fs".to_string()], NO_ANSWER)));
    assert!(m.permission_rules["opencode"].busy.is_empty());
    assert_eq!(m.permission_rules["opencode"].error.as_deref(), Some(NO_ANSWER));
    let acct = &m.accounts["opencode"];
    assert!(acct.busy.is_empty());
    assert_eq!(acct.error.as_deref(), Some(NO_ANSWER));
    let sign_in = acct.sign_in.as_ref().unwrap();
    assert_eq!(sign_in.status, SignInStatus::Failed);
    assert_eq!(sign_in.error.as_deref(), Some(NO_ANSWER));
    let session = m.sessions["s1"].mcp.as_ref().unwrap();
    assert!(session.busy.is_empty());
    assert_eq!(session.error.as_deref(), Some(NO_ANSWER));

    assert!(!st.expire_unanswered(t + SLOW_SETTINGS_ANSWER_TIMEOUT_MS - 1));
    assert!(st.expire_unanswered(t + SLOW_SETTINGS_ANSWER_TIMEOUT_MS));
    let p = &st.machine("pk").unwrap().plugins["claude-code"];
    assert!(p.busy.is_empty());
    assert_eq!(p.failure.as_ref().unwrap().error, NO_ANSWER);
}

#[test]
fn an_agent_removal_waits_as_long_as_the_work_can_take_and_an_install_does_not() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    st.agent_action_sent("pk", "opencode", AgentAction::Remove, 0);
    st.agent_action_sent("pk", "claude-code", AgentAction::Install, 0);
    assert!(st.expire_unanswered(SETTINGS_ANSWER_TIMEOUT_MS));
    let m = st.machine("pk").unwrap();
    assert!(m.agent_actions["claude-code"].busy.is_none(), "an install is answered when taken up");
    assert!(m.agent_actions["opencode"].busy.is_some(), "a removal is answered when done");
    assert!(st.expire_unanswered(SLOW_SETTINGS_ANSWER_TIMEOUT_MS));
    assert!(st.machine("pk").unwrap().agent_actions["opencode"].busy.is_none());
}

#[test]
fn any_later_answer_clears_a_did_not_answer_note_but_not_a_real_failure() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 0);
    st.mcp_action_sent("pk", "claude-code", McpAction::Add, &["fs".to_string()], 0);
    st.account_action_sent("pk", "opencode", "a", false, 0);
    assert!(st.expire_unanswered(SLOW_SETTINGS_ANSWER_TIMEOUT_MS));

    // The machine is back: its lists and a sign-in answer arrive.
    st.apply_plugins(
        "pk",
        &PluginsMsg {
            agent: "claude-code".into(),
            installed: vec![],
            marketplaces: None,
            toggles: false,
            install_hint: None,
            install_note: None,
            available: None,
            error: None,
        },
    );
    st.apply_mcp("pk", &McpServersMsg { agent: "claude-code".into(), servers: vec![], toggles: false, error: None });
    st.apply_account_sign_in(
        "pk",
        &AccountSignInMsg {
            agent: "opencode".into(),
            account: "b".into(),
            status: SignInStatus::Started,
            attempt_id: None,
            attempt: None,
            error: None,
        },
    );
    let m = st.machine("pk").unwrap();
    assert!(m.plugins["claude-code"].failure.is_none());
    assert!(m.mcp["claude-code"].failure.is_none());
    assert!(m.accounts["opencode"].error.is_none());

    // A failure the machine itself reported stays until the next change.
    st.apply_mcp_ack(
        "pk",
        &McpAckMsg { agent: "claude-code".into(), action: McpAction::Add, names: vec!["fs".into()], success: false, error: Some("bad url".into()) },
    );
    st.apply_mcp("pk", &McpServersMsg { agent: "claude-code".into(), servers: vec![], toggles: false, error: None });
    assert_eq!(st.machine("pk").unwrap().mcp["claude-code"].failure.as_ref().map(|f| f.error.as_str()), Some("bad url"));
}

#[test]
fn a_change_answered_before_its_deadline_is_not_touched_by_giving_up() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    let t = 1_000;
    st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", t);
    st.apply_plugin_ack(
        "pk",
        &PluginAckMsg {
            agent: "claude-code".into(),
            action: PluginAction::Install,
            target: "b@m".into(),
            success: true,
            error: None,
            message: None,
        },
    );

    // It is settled, so giving up on it reports no change and does not
    // overwrite the answer with a "did not answer".
    assert!(!st.expire_unanswered(t + SETTINGS_ANSWER_TIMEOUT_MS));
    let p = &st.machine("pk").unwrap().plugins["claude-code"];
    assert!(p.busy.is_empty());
    assert!(p.failure.is_none());
}

#[test]
fn a_sign_in_the_machine_answered_is_not_failed_by_giving_up() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    let t = 1_000;
    st.account_action_sent("pk", "opencode", "b", true, t);
    // The machine answers, but says nothing yet about what to do.
    st.apply_account_sign_in(
        "pk",
        &AccountSignInMsg {
            agent: "opencode".into(),
            account: "b".into(),
            status: SignInStatus::Started,
            attempt_id: None,
            attempt: None,
            error: None,
        },
    );

    assert!(!st.expire_unanswered(t + SETTINGS_ANSWER_TIMEOUT_MS));
    let a = &st.machine("pk").unwrap().accounts["opencode"];
    assert_eq!(a.sign_in.as_ref().unwrap().status, SignInStatus::Started);
    assert!(a.error.is_none());
}

#[test]
fn resending_a_change_pushes_its_deadline_without_duplicating_it() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 1_000);
    assert_eq!(st.next_unanswered_deadline(), Some(1_000 + SLOW_SETTINGS_ANSWER_TIMEOUT_MS));
    st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 2_000);
    assert_eq!(
        st.next_unanswered_deadline(),
        Some(2_000 + SLOW_SETTINGS_ANSWER_TIMEOUT_MS),
        "the resend replaces the entry's time rather than adding a second"
    );

    // The first deadline passes without effect; the second gives up.
    assert!(!st.expire_unanswered(1_000 + SLOW_SETTINGS_ANSWER_TIMEOUT_MS));
    assert!(st.machine("pk").unwrap().plugins["claude-code"].busy.contains(&"b@m".to_string()));
    assert!(st.expire_unanswered(2_000 + SLOW_SETTINGS_ANSWER_TIMEOUT_MS));
    assert!(st.machine("pk").unwrap().plugins["claude-code"].busy.is_empty());
}

#[test]
fn an_answer_that_arrives_after_the_giving_up_still_applies() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    let t = 1_000;
    st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", t);
    assert!(st.expire_unanswered(t + SLOW_SETTINGS_ANSWER_TIMEOUT_MS));
    assert!(st.machine("pk").unwrap().plugins["claude-code"].failure.is_some());

    // A late answer lands normally and replaces the "did not answer" note.
    st.apply_plugin_ack(
        "pk",
        &PluginAckMsg {
            agent: "claude-code".into(),
            action: PluginAction::Install,
            target: "b@m".into(),
            success: true,
            error: None,
            message: Some("done".into()),
        },
    );
    let p = &st.machine("pk").unwrap().plugins["claude-code"];
    assert!(p.failure.is_none());
    assert_eq!(p.notice.as_ref().map(|n| n.message.as_str()), Some("done"));
}

#[test]
fn the_next_deadline_is_the_earliest_change_still_in_flight() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    assert_eq!(st.next_unanswered_deadline(), None);
    st.agent_action_sent("pk", "opencode", AgentAction::Install, 5_000);
    st.mcp_action_sent("pk", "claude-code", McpAction::Remove, &["fs".to_string()], 1_000);
    assert_eq!(st.next_unanswered_deadline(), Some(1_000 + SETTINGS_ANSWER_TIMEOUT_MS));

    // Giving up on the earliest leaves the later one in flight.
    assert!(st.expire_unanswered(1_000 + SETTINGS_ANSWER_TIMEOUT_MS));
    assert_eq!(st.next_unanswered_deadline(), Some(5_000 + SETTINGS_ANSWER_TIMEOUT_MS));
    assert!(st.expire_unanswered(5_000 + SETTINGS_ANSWER_TIMEOUT_MS));
    assert_eq!(st.next_unanswered_deadline(), None);
}

#[test]
fn giving_up_on_a_change_whose_machine_is_gone_changes_nothing() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "m", None, None, &[]);
    st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 0);
    st.remove_machine("pk");
    assert!(!st.expire_unanswered(SLOW_SETTINGS_ANSWER_TIMEOUT_MS));
    assert_eq!(st.next_unanswered_deadline(), None);
}

#[test]
fn each_agents_model_list_is_tracked_separately() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[], NONE()), 10);
    st.apply_models("pk", &models_msg(&["opus"], Some("opus")));
    st.apply_models(
        "pk",
        &ModelsMsg {
            agent: "opencode".into(),
            models: vec![ModelEntry { id: "gpt".into(), ..Default::default() }],
            default_model: None,
            error: None,
        },
    );
    st.apply_models(
        "pk",
        &ModelsMsg {
            agent: "opencode".into(),
            models: vec![],
            default_model: None,
            error: Some("opencode offline".into()),
        },
    );
    assert_eq!(agent_models(&st, "claude-code").models.as_ref().unwrap()[0].id, "opus");
    assert_eq!(agent_models(&st, "claude-code").default_model.as_deref(), Some("opus"));
    assert_eq!(agent_models(&st, "claude-code").error, None);
    assert_eq!(agent_models(&st, "opencode").models.as_ref().unwrap()[0].id, "gpt");
    assert_eq!(agent_models(&st, "opencode").error.as_deref(), Some("opencode offline"));
}

#[test]
fn a_credentials_ack_patches_the_bridge_or_the_named_agent() {
    let mut st = MachinesState::default();
    st.apply_session_list(
        "pk",
        &list(&[], json!({ "agents": [{ "id": "claude-code", "displayName": "Claude Code" }] })),
        10,
    );
    let set = |id: &str| CredentialStatus {
        id: id.into(),
        label: id.into(),
        present: true,
        from_env: false,
        valid: Some(true),
    };
    st.apply_credential_statuses("pk", Some("claude-code"), &[set("anthropic_api_key")]);
    st.apply_credential_statuses("pk", None, &[set("github_pat")]);
    let m = st.machine("pk").unwrap();
    assert_eq!(m.agent("claude-code").unwrap().credentials[0].id, "anthropic_api_key");
    assert_eq!(m.credentials[0].id, "github_pat");
}

#[test]
fn a_field_less_heartbeat_keeps_the_host_badge_but_a_new_host_wins() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[], json!({ "host": "service" })), 10);
    assert_eq!(st.machine("pk").unwrap().host, Some(BridgeHostKind::Service));
    st.apply_session_list("pk", &list(&[], NONE()), 20);
    assert_eq!(st.machine("pk").unwrap().host, Some(BridgeHostKind::Service));
    st.apply_session_list("pk", &list(&[], json!({ "host": "cli" })), 30);
    assert_eq!(st.machine("pk").unwrap().host, Some(BridgeHostKind::Cli));
}

#[test]
fn two_pubkeys_with_the_same_name_stay_two_machines() {
    let mut st = MachinesState::default();
    st.apply_session_list("pkA", &list(&[], json!({ "machine": "box", "host": "cli" })), 1);
    st.apply_session_list("pkB", &list(&[], json!({ "machine": "box", "host": "service" })), 1);
    assert_eq!(st.machine_pubkeys(), vec!["pkA", "pkB"]);
    assert_eq!(st.machine("pkA").unwrap().host, Some(BridgeHostKind::Cli));
    assert_eq!(st.machine("pkB").unwrap().host, Some(BridgeHostKind::Service));
}

#[test]
fn user_remove_session_is_a_local_removal_path() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[info("a"), info("b")], NONE()), 1);
    st.user_remove_session("pk", "a");
    assert!(st.session("pk", "a").is_none());
    assert!(st.session("pk", "b").is_some());
}

#[test]
fn the_resurrection_shield_keeps_a_deleted_session_out_of_a_stale_heartbeat() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[info("a"), info("b")], NONE()), 1);
    // deleteController does both: remove now + shield against resurrection.
    st.user_remove_session("pk", "a");
    st.dismiss_session("pk", "a", 2);
    // a stale heartbeat still lists `a` — the shield filters it BEFORE the
    // merge, so it does not come back, however long that goes on.
    st.apply_session_list("pk", &list(&[info("a"), info("b")], NONE()), 3);
    assert!(st.session("pk", "a").is_none());
    assert!(st.session("pk", "b").is_some());
    st.apply_session_list("pk", &list(&[info("a")], NONE()), DISMISSED_TTL_MS + 4);
    assert!(st.session("pk", "a").is_none());
}

#[test]
fn title_guard_covers_upsert() {
    let mut st = MachinesState::default();
    st.register_machine("m1", "m1", None, None, &[]);
    st.apply_session_upsert("m1", &info("s1"), 0);
    st.note_first_user_message("m1", "s1", "stopgap");

    st.apply_session_upsert("m1", &info("s1"), 1); // titleless upsert
    assert_eq!(st.session("m1", "s1").unwrap().info.title.as_deref(), Some("stopgap"));

    st.apply_session_upsert("m1", &titled("s1", "bridge"), 2); // titled wins
    assert_eq!(st.session("m1", "s1").unwrap().info.title.as_deref(), Some("bridge"));
}

#[test]
fn note_first_user_message_only_titles_an_untitled_known_session_once() {
    let mut st = MachinesState::default();
    st.register_machine("m1", "m1", None, None, &[]);
    st.apply_session_upsert("m1", &info("s1"), 0);

    st.note_first_user_message("m1", "UNKNOWN", "hi");
    assert!(st.session("m1", "UNKNOWN").is_none());

    st.note_first_user_message("m1", "s1", "first\nmessage  ");
    assert_eq!(st.session("m1", "s1").unwrap().info.title.as_deref(), Some("first message"));
    st.note_first_user_message("m1", "s1", "second");
    assert_eq!(st.session("m1", "s1").unwrap().info.title.as_deref(), Some("first message"));

    st.apply_session_upsert("m1", &info("s2"), 1);
    st.note_first_user_message("m1", "s2", "  \n \n ");
    assert_eq!(st.session("m1", "s2").unwrap().info.title, None);
}

#[test]
fn update_session_info_patches_in_place() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[info("s1")], NONE()), 1);
    st.update_session_info("pk", "s1", |i| i.model = Some("opus".into()));
    assert_eq!(st.session("pk", "s1").unwrap().info.model.as_deref(), Some("opus"));
    // unknown session is a no-op, not a panic
    st.update_session_info("pk", "ghost", |i| i.model = Some("x".into()));
}

#[test]
fn relays_are_per_machine_learned_at_pairing_and_editable() {
    let mut st = MachinesState::default();
    let r = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    st.register_machine("pk1", "M1", None, None, &r(&["wss://a", "wss://b"]));
    st.register_machine("pk2", "M2", None, None, &r(&["wss://b", "wss://c"]));
    // Re-pairing adds what it learned, keeps what was there.
    st.register_machine("pk1", "M1", None, None, &r(&["wss://d"]));
    assert_eq!(st.machine("pk1").unwrap().relays, r(&["wss://a", "wss://b", "wss://d"]));
    assert_eq!(st.relay_set(), r(&["wss://a", "wss://b", "wss://d", "wss://c"]));

    assert!(st.set_relays("pk2", r(&[" wss://c ", "wss://e", "wss://c"])));
    assert_eq!(st.machine("pk2").unwrap().relays, r(&["wss://c", "wss://e"]));
    // Never left unreachable, never a URL the phone may not dial.
    assert!(!st.set_relays("pk2", vec![]));
    assert!(!st.set_relays("pk2", r(&["ws://cleartext.example"])));
    assert!(!st.set_relays("ghost", r(&["wss://x"])));
    assert_eq!(st.machine("pk2").unwrap().relays, r(&["wss://c", "wss://e"]));

    let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
    assert_eq!(back["pk2"].relays, r(&["wss://c", "wss://e"]));
}

#[test]
fn new_session_defaults_are_per_machine_and_agent() {
    let mut st = MachinesState::default();
    st.register_machine("pk", "M", None, None, &[]);
    assert!(st.set_default_agent("pk", Some(" opencode ".into())));
    let d = |mode: &str, model: &str| AgentDefaults { mode: mode.into(), model: model.into(), ..Default::default() };
    assert!(st.set_agent_defaults("pk", "claude-code", d("plan", " opus ")));
    assert_eq!(st.machine("pk").unwrap().default_agent.as_deref(), Some("opencode"));
    assert_eq!(st.machine("pk").unwrap().agent_defaults["claude-code"], d("plan", "opus"));

    let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
    assert_eq!(back["pk"].agent_defaults["claude-code"], d("plan", "opus"));

    // All-empty forgets the agent's entry; an empty agent clears the pick.
    assert!(st.set_agent_defaults("pk", "claude-code", AgentDefaults::default()));
    assert!(st.machine("pk").unwrap().agent_defaults.is_empty());
    // A persona alone is a default worth keeping.
    assert!(st.set_agent_defaults("pk", "opencode", AgentDefaults { persona: " review ".into(), ..Default::default() }));
    assert_eq!(st.machine("pk").unwrap().agent_defaults["opencode"].persona, "review");
    assert!(st.set_default_agent("pk", Some("".into())));
    assert_eq!(st.machine("pk").unwrap().default_agent, None);
    assert!(!st.set_default_agent("ghost", None));
}

#[test]
fn serialize_then_hydrate_never_truncates() {
    let mut st = MachinesState::default();
    st.register_machine("pk1", "M1", Some("Laptop".into()), None, &[]);
    st.apply_session_list("pk1", &list(&[info("a"), info("b")], NONE()), 50);
    st.apply_session_list("pk1", &list(&[info("a")], NONE()), 60); // b -> stale
    st.register_machine("pk2", "M2", None, None, &[]);
    st.apply_models("pk1", &models_msg(&["opus", "fable"], Some("opus")));

    let hydrated = hydrate_machines(Some(&serialize_machines(&st.machines)));
    assert_eq!(hydrated.keys().cloned().collect::<Vec<_>>(), vec!["pk1", "pk2"]);
    assert_eq!(
        hydrated["pk1"].sessions.keys().cloned().collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    assert_eq!(hydrated["pk1"].sessions["b"].presence, ListingPresence::Offline);
    assert_eq!(hydrated["pk1"].label.as_deref(), Some("Laptop"));
    assert!(hydrated["pk1"].machine_offline); // honest until a live heartbeat
    assert_eq!(
        hydrated["pk1"].models["claude-code"].models.as_ref().unwrap()[0].id,
        "opus"
    );
}

#[test]
fn hydrate_tolerates_garbage_without_panicking() {
    assert!(hydrate_machines(None).is_empty());
    assert!(hydrate_machines(Some("not json")).is_empty());
    assert!(hydrate_machines(Some(r#"{"a":1}"#)).is_empty());
    assert!(hydrate_machines(Some(r#"[{"nope":true}]"#)).is_empty());
}

#[test]
fn provider_profiles_never_persist_but_survive_hydration_round_trip_as_none() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[], NONE()), 1);
    st.apply_provider_profiles(
        "pk",
        &ProviderProfilesMsg { machine: "pk".into(), profiles: vec![] },
    );
    assert!(st.machine("pk").unwrap().provider_profiles.is_some());
    let hydrated = hydrate_machines(Some(&serialize_machines(&st.machines)));
    assert!(hydrated["pk"].provider_profiles.is_none());
}

/// `#[serde(skip)]` would have hidden `provider_profiles` from every
/// serialization, including the live `MachinesView` the UI reads over IPC
/// — silently breaking the machine-providers screen the moment the phone
/// re-points at this core. Only `serialize_machines` (the KV-persistence
/// path) may strip it.
#[test]
fn provider_profiles_serializes_in_the_live_view_json() {
    let mut st = MachinesState::default();
    st.apply_session_list("pk", &list(&[], NONE()), 1);
    st.apply_provider_profiles(
        "pk",
        &ProviderProfilesMsg {
            machine: "pk".into(),
            profiles: vec![ProviderProfileInfo {
                id: "prof1".into(),
                agent: "claude-code".into(),
                label: "Anthropic".into(),
                base_url: "https://api.example".into(),
                models: vec![],
                models_from_provider: false,
                default_model: None,
                has_token: true,
                error: None,
            }],
        },
    );
    let json = serde_json::to_string(st.machine("pk").unwrap()).unwrap();
    assert!(json.contains("providerProfiles"));
    assert!(json.contains("prof1"));
}

#[test]
fn property_sessions_survive_everything_but_a_tombstone() {
    let universe: Vec<String> = (0..8).map(|i| format!("s{i}")).collect();
    for seed in 1..=200u32 {
        let mut rnd = prng(seed);
        let mut state: BTreeMap<String, SessionView> = BTreeMap::new();
        let mut ever_known: std::collections::BTreeSet<String> = Default::default();
        let mut tombstoned: std::collections::BTreeSet<String> = Default::default();
        let mut now = 0u64;

        for step in 0..30 {
            now += (rnd() * 1000.0) as u64;
            let listed: Vec<RemoteSessionInfo> = universe
                .iter()
                .filter(|_| rnd() < 0.4)
                .map(|id| info(id))
                .collect();
            let removed: Vec<String> =
                universe.iter().filter(|_| rnd() < 0.1).cloned().collect();
            let machine_offline = rnd() < 0.15;

            let mut extra = serde_json::Map::new();
            if !removed.is_empty() {
                extra.insert("removedSessions".into(), json!(removed));
            }
            if machine_offline {
                extra.insert("machineOffline".into(), json!(true));
            }
            let msg = list(&listed, serde_json::Value::Object(extra));

            for s in &listed {
                ever_known.insert(s.id.clone());
                tombstoned.remove(&s.id); // re-listing resurrects
            }
            for id in &removed {
                tombstoned.insert(id.clone());
            }

            state = merge_session_list(&state, &msg, now, MergeOptions::default());

            for id in &ever_known {
                if tombstoned.contains(id) {
                    assert!(
                        !state.contains_key(id),
                        "seed {seed} step {step}: tombstoned {id} survived"
                    );
                } else {
                    assert!(
                        state.contains_key(id),
                        "seed {seed} step {step}: lost session {id}"
                    );
                }
            }
        }
    }
}

#[test]
fn the_direct_target_is_the_advertised_endpoints_then_the_users_own() {
    let mut s = MachinesState::new(Default::default(), MergeOptions::default());
    s.apply_session_list("m", &list(&[], json!({})), 1);
    assert_eq!(s.direct_target("m"), None, "nothing advertised, nothing added");

    let direct = json!({"direct": {"endpoints": ["wss://192.168.1.20:7447"], "certSha256": "ab"}});
    s.apply_session_list("m", &list(&[], direct), 2);
    assert!(s.set_direct_endpoints("m", vec![" wss://laptop.ts.net:7447 ".into(), "wss://192.168.1.20:7447".into()]));
    assert_eq!(
        s.direct_target("m"),
        Some((vec!["wss://192.168.1.20:7447".into(), "wss://laptop.ts.net:7447".into()], Some("ab".into())))
    );
    // A heartbeat without it withdraws the advertised part only.
    s.apply_session_list("m", &list(&[], json!({})), 3);
    assert_eq!(s.direct_target("m").unwrap().0.len(), 2, "the user's own stay");
    assert_eq!(s.direct_target("m").unwrap().1, None);

    assert!(!s.set_direct_endpoints("m", vec!["ws://192.168.1.20:7447".into()]), "no cleartext off Tor");
    assert!(!s.set_direct_endpoints("unknown", vec![]));
    assert!(s.set_direct_endpoints("m", vec!["ws://abc.onion:7448".into()]));
}
