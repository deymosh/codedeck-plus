use super::*;

async fn stores() -> (CoreStores, PhoneKeys) {
    (crate::test_support::stores().await, crate::test_support::phone_keys())
}

fn ctx() -> IntentCtx {
    IntentCtx {
        now: 1_000,
        visible: true,
        terminal_transport: InputTransport::Direct,
    }
}

/// Documents the JSON shape a binding sends: externally tagged, camelCase
/// fields. A change here is a deliberate, visible break to that shape.
#[test]
fn intent_json_shape_is_externally_tagged_camel_case() {
    let i = Intent::SendInput {
        machine: "m".into(),
        session_id: "s1".into(),
        text: "hi".into(),
        input_id: "in-1".into(),
    };
    let v = serde_json::to_value(&i).unwrap();
    assert_eq!(
        v,
        serde_json::json!({
            "sendInput": { "machine": "m", "sessionId": "s1", "text": "hi", "inputId": "in-1" }
        })
    );
    assert_eq!(serde_json::from_value::<Intent>(v).unwrap(), i);

    // A unit variant is the bare tag string, not `{ "undoDelete": null }" —
    // serde's external-tagging convention for a variant with no payload.
    assert_eq!(serde_json::to_value(Intent::UndoDelete).unwrap(), "undoDelete");
}

#[tokio::test]
async fn send_input_queues_an_outbox_item_clears_unread_and_stamps_a_stopgap_title() {
    use client_core::stores::outbox::OutboxItemState;
    let (mut s, kp) = stores().await;
    s.machines.register_machine("m", "laptop", None, None, &[]);
    s.ui.mark_session_unread("m", "s1");

    let out = apply(
        &mut s,
        Intent::SendInput {
            machine: "m".into(),
            session_id: "s1".into(),
            text: "fix the build\nplease".into(),
            input_id: "in-1".into(),
        },
        &kp,
        ctx(),
    );

    assert_eq!(s.outbox.items["in-1"].state, OutboxItemState::Pending);
    assert!(!s.ui.is_session_unread("m", "s1"));
    assert!(out.persist.contains(&StoreId::Outbox));
    let o = out.outbox_send.unwrap();
    assert_eq!(o.id, "in-1");
    assert!(matches!(
        o.msg,
        PhoneToBridge::Input(m) if m.input_id.as_deref() == Some("in-1") && m.text == "fix the build\nplease"
    ));
}

#[tokio::test]
async fn retry_outbox_item_only_fires_for_a_failed_item() {
    use client_core::stores::outbox::OutboxState;
    let (mut s, kp) = stores().await;
    let item = OutboxState::new_input("in-1", "m", "s1", "hi", 100);
    s.outbox.begin_publish(item);
    // still Pending → retry is a no-op
    assert_eq!(
        apply(
        &mut s, Intent::RetryOutboxItem { machine: "m".into(), id: "in-1".into() }, &kp, ctx()),
        IntentResult::default()
    );
    // fail it, then retry re-queues
    s.outbox.fail("in-1", "boom", 200);
    let out = apply(
        &mut s,
        Intent::RetryOutboxItem { machine: "m".into(), id: "in-1".into() },
        &kp,
        ctx(),
    );
    assert!(out.outbox_send.is_some());
    assert_eq!(s.outbox.items["in-1"].attempts, 2);
}

#[tokio::test]
async fn an_mcp_add_is_checked_before_it_is_sent() {
    use protocol::common::McpTransport;
    let (mut s, kp) = stores().await;
    s.machines.register_machine("m", "laptop", None, None, &[]);
    let add = |url: &str| Intent::McpAction {
        machine: "m".into(),
        agent: "claude-code".into(),
        action: McpAction::Add,
        servers: vec![McpServerSpec {
            name: "gh".into(),
            transport: McpTransport::Http { url: url.into(), headers: Default::default() },
        }],
        names: vec![],
    };

    let out = apply(&mut s, add("ftp://x"), &kp, ctx());
    assert!(out.sends.is_empty(), "a bad server never leaves the phone");
    let held = s.machines.machine("m").unwrap().mcp["claude-code"].clone();
    assert!(held.busy.is_empty() && held.failure.is_some_and(|f| f.names == ["gh"]));

    let out = apply(&mut s, add("https://x/mcp"), &kp, ctx());
    assert!(matches!(&out.sends[..], [Send { msg: PhoneToBridge::McpAction(m), .. }] if m.names == ["gh"]));
    assert_eq!(s.machines.machine("m").unwrap().mcp["claude-code"].busy, ["gh"]);
}

#[tokio::test]
async fn a_permission_rule_removal_marks_its_rules_busy_and_an_empty_one_is_not_sent() {
    let (mut s, kp) = stores().await;
    s.machines.register_machine("m", "laptop", None, None, &[]);
    let remove = |ids: Vec<String>| Intent::RemovePermissionRules { machine: "m".into(), agent: "opencode".into(), ids };

    let out = apply(&mut s, remove(vec![]), &kp, ctx());
    assert!(out.sends.is_empty());

    let out = apply(&mut s, remove(vec!["psv_1".into()]), &kp, ctx());
    assert!(matches!(&out.sends[..], [Send { msg: PhoneToBridge::PermissionRulesRemove(m), .. }] if m.ids == ["psv_1"]));
    assert_eq!(s.machines.machine("m").unwrap().permission_rules["opencode"].busy, ["psv_1"]);
}

#[tokio::test]
async fn delete_session_dismisses_removes_arms_the_undo_and_shows_a_toast() {
    use protocol::common::RemoteSessionInfo;
    let (mut s, kp) = stores().await;
    s.machines.register_machine("m", "laptop", None, None, &[]);
    s.machines.apply_session_upsert(
        "m",
        &RemoteSessionInfo {
            id: "s1".into(),
            agent: "claude-code".into(),
            slug: "the-slug".into(),
            cwd: "/w".into(),
            last_activity: "t".into(),
            line_count: 0,
            title: None,
            project: "p".into(),
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
        },
        0,
    );

    let out = apply(
        &mut s,
        Intent::DeleteSession {
            machine: "m".into(),
            session_id: "s1".into(),
            label: None,
        },
        &kp,
        ctx(),
    );
    assert!(s.machines.session("m", "s1").is_none()); // removed locally
    assert!(s.machines.dismissed_sessions.contains_key("s1")); // + shielded
    assert!(matches!(out.undo_timer, Some(UndoTimer::Arm { .. })));
    assert!(out.persist.contains(&StoreId::Machines));
    assert!(s.ui.undo_toast.is_some());
    // no close-session yet — only after the window
    assert!(out.sends.is_empty());

    // undo restores the snapshot
    let undo = apply(&mut s, Intent::UndoDelete, &kp, ctx());
    assert!(s.machines.session("m", "s1").is_some());
    assert_eq!(undo.undo_timer, Some(UndoTimer::Clear));
    assert!(s.ui.undo_toast.is_none());
}

#[tokio::test]
async fn remove_machine_forgets_it_deselects_and_queues_its_sessions_for_transcript_removal() {
    use protocol::common::RemoteSessionInfo;
    let (mut s, kp) = stores().await;
    s.machines.register_machine("m", "laptop", None, None, &[]);
    s.machines.apply_session_upsert(
        "m",
        &RemoteSessionInfo {
            id: "s1".into(),
            agent: "claude-code".into(),
            slug: "the-slug".into(),
            cwd: "/w".into(),
            last_activity: "t".into(),
            line_count: 0,
            title: None,
            project: "p".into(),
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
        },
        0,
    );
    s.ui.select_machine(Some("m"));
    s.ui.mark_session_unread("m", "s1");
    // Unsent messages: to a listed session, and to one no longer listed.
    use client_core::stores::outbox::OutboxState;
    s.outbox.begin_publish(OutboxState::new_input("in-1", "m", "s1", "hi", 1));
    s.outbox.begin_publish(OutboxState::new_input("in-2", "m", "gone", "hi", 1));
    s.outbox.begin_publish(OutboxState::new_input("in-3", "other", "s9", "hi", 1));

    let out = apply(
        &mut s,
        Intent::RemoveMachine { pubkey_hex: "m".into() },
        &kp,
        ctx(),
    );

    assert!(s.machines.machine("m").is_none());
    assert!(out.resubscribe);
    assert!(out.persist.contains(&StoreId::Machines));
    assert!(out.ui_changed);
    assert_eq!(out.transcript_removed, vec![("m".to_string(), "s1".to_string())]);
    assert!(!s.ui.is_session_unread("m", "s1"));
    assert_eq!(s.ui.selected_machine, None);
    assert_eq!(s.outbox.items.keys().collect::<Vec<_>>(), ["in-3"]);
    assert!(out.persist.contains(&StoreId::Outbox));
    assert_eq!(out.ui_effects, vec![UiEffect::SessionDeleted { machine: "m".into(), session_id: "s1".into() }]);
}

#[tokio::test]
async fn remove_machine_leaves_the_selection_alone_when_a_different_machine_is_selected() {
    let (mut s, kp) = stores().await;
    s.machines.register_machine("m1", "laptop", None, None, &[]);
    s.machines.register_machine("m2", "desktop", None, None, &[]);
    s.ui.select_machine(Some("m2"));

    let out = apply(
        &mut s,
        Intent::RemoveMachine { pubkey_hex: "m1".into() },
        &kp,
        ctx(),
    );

    assert!(s.machines.machine("m1").is_none());
    assert!(s.machines.machine("m2").is_some());
    assert!(out.resubscribe);
    assert_eq!(s.ui.selected_machine.as_deref(), Some("m2"));
}

#[tokio::test]
async fn remove_machine_on_an_unknown_machine_is_a_harmless_no_op() {
    let (mut s, kp) = stores().await;
    let out = apply(
        &mut s,
        Intent::RemoveMachine { pubkey_hex: "ghost".into() },
        &kp,
        ctx(),
    );
    assert_eq!(out, IntentResult::default());
}

#[tokio::test]
async fn begin_manual_pairing_stages_a_candidate_and_sends_a_pair_request() {
    let (mut s, kp) = stores().await;
    let peer = protocol::crypto::generate_keypair();

    let out = apply(
        &mut s,
        Intent::BeginManualPairing {
            npub: peer.npub.clone(),
            token: "tok".into(),
            relays: "wss://typed.example".into(),
            label: "my phone".into(),
        },
        &kp,
        ctx(),
    );

    assert_eq!(
        s.pairing.candidate.as_ref().unwrap().pubkey_hex,
        peer.pubkey_hex
    );
    assert_eq!(s.relay_set(), vec!["wss://typed.example"]);
    assert!(matches!(out.pair_deadline, Some(PairDeadline::Arm { .. })));
    assert!(out.resubscribe);
    assert!(matches!(
        out.sends.as_slice(),
        [Send { machine, msg: PhoneToBridge::PairRequest(m) }]
            if *machine == peer.pubkey_hex
                && m.pubkey_hex == kp.identity_pubkey_hex
                && m.session_key.as_ref().is_some_and(|k| k.pubkey_hex == kp.session_pubkey_hex)
                && m.token == "tok"
    ));

    // an invalid npub sets the error, no candidate, no send
    let mut s2 = stores().await.0;
    let bad = apply(
        &mut s2,
        Intent::BeginManualPairing {
            npub: "npub1nope".into(),
            token: "t".into(),
            relays: "wss://r.example".into(),
            label: "x".into(),
        },
        &kp,
        ctx(),
    );
    assert!(s2.pairing.candidate.is_none());
    assert!(s2.pairing.error.is_some());
    assert_eq!(bad, IntentResult::default());

    // without a relay there is nowhere to send the request
    let mut s3 = stores().await.0;
    apply(
        &mut s3,
        Intent::BeginManualPairing {
            npub: peer.npub.clone(),
            token: "t".into(),
            relays: " ".into(),
            label: "x".into(),
        },
        &kp,
        ctx(),
    );
    assert!(s3.pairing.candidate.is_none());
    assert_eq!(s3.pairing.error.as_deref(), Some("missing relays"));
}

#[tokio::test]
async fn begin_pairing_from_a_url_puts_its_relays_in_the_relay_set() {
    let (mut s, kp) = stores().await;
    let bridge = protocol::crypto::generate_keypair();
    assert!(s.relay_set().is_empty(), "a phone has no relays of its own");

    let url = format!(
        "codedeck://pair?npub={}&relays=wss%3A%2F%2Fnew-relay.example&machine=bridge&token=tok",
        bridge.npub
    );
    let out = apply(
        &mut s,
        Intent::BeginPairing { url, label: "my phone".into() },
        &kp,
        ctx(),
    );

    // The candidate's relays are in the set the loop points the transport
    // at (`interpret_intent` syncs it before `out.sends`), and its
    // pair-request goes only there.
    assert_eq!(s.relay_set(), vec!["wss://new-relay.example"]);
    assert_eq!(s.relays_for(&bridge.pubkey_hex), vec!["wss://new-relay.example"]);
    assert!(matches!(
        out.sends.as_slice(),
        [Send { machine, msg: PhoneToBridge::PairRequest(_) }] if *machine == bridge.pubkey_hex
    ));
}

#[tokio::test]
async fn respond_permission_marks_the_card_and_sends() {
    let (mut s, kp) = stores().await;
    let out = apply(
        &mut s,
        Intent::RespondPermission {
            machine: "m".into(),
            session_id: "s1".into(),
            request_id: "req-1".into(),
            option_id: "allow".into(),
        },
        &kp,
        ctx(),
    );
    assert!(s.ui.is_card_responded("m", "s1", "req-1"));
    assert!(matches!(
        out.sends.as_slice(),
        [Send { machine, msg: PhoneToBridge::PermissionResponse(m) }]
            if machine == "m" && m.option_id == "allow" && m.request_id == "req-1"
    ));
}

#[tokio::test]
async fn set_credentials_carries_set_and_clear_and_notes_the_pending_save() {
    let (mut s, kp) = stores().await;
    let values: CredentialValues = [
        ("anthropic_api_key".to_string(), Some("sk-ant-xyz".to_string())),
        ("old".to_string(), None),
    ]
    .into();
    let out = apply(
        &mut s,
        Intent::SetCredentials {
            machine: "m".into(),
            agent: Some("claude-code".into()),
            values: values.clone(),
        },
        &kp,
        ctx(),
    );
    assert!(matches!(
        out.sends.as_slice(),
        [Send { machine, msg: PhoneToBridge::SetCredentials(m) }]
            if machine == "m" && m.agent.as_deref() == Some("claude-code") && m.values == values
    ));
    assert_eq!(
        s.ui.credentials_status["m"].state,
        client_core::stores::ui::AckState::Saving
    );
}

#[tokio::test]
async fn answering_one_question_marks_only_that_question_responded() {
    let (mut s, kp) = stores().await;
    let out = apply(
        &mut s,
        Intent::AnswerQuestion {
            machine: "m".into(),
            session_id: "s1".into(),
            request_id: "q".into(),
            index: 1,
            answer: QuestionAnswer::Options { selected: vec![0] },
        },
        &kp,
        ctx(),
    );
    assert!(s.ui.is_card_responded("m", "s1", "q:q1"));
    assert!(!s.ui.is_card_responded("m", "s1", "q:q0"));
    assert!(matches!(
        out.sends.as_slice(),
        [Send { msg: PhoneToBridge::QuestionResponse(m), .. }] if m.index == 1 && m.request_id == "q"
    ));
}

#[tokio::test]
async fn set_provider_profile_upsert_and_delete_both_send() {
    let (mut s, kp) = stores().await;
    let out = apply(
        &mut s,
        Intent::SetProviderProfile {
            machine: "m".into(),
            profile_id: "p1".into(),
            profile: None,
        },
        &kp,
        ctx(),
    );
    assert!(matches!(
        out.sends.as_slice(),
        [Send { machine, msg: PhoneToBridge::SetProviderProfile(m) }]
            if machine == "m" && m.profile_id == "p1" && m.profile.is_none()
    ));
}

#[tokio::test]
async fn request_provider_profiles_sends_a_bare_request() {
    let (mut s, kp) = stores().await;
    let out = apply(
        &mut s,
        Intent::RequestProviderProfiles { machine: "m".into() },
        &kp,
        ctx(),
    );
    assert!(matches!(
        out.sends.as_slice(),
        [Send { machine, msg: PhoneToBridge::ProviderProfilesRequest(_) }] if machine == "m"
    ));
}

#[tokio::test]
async fn web_sign_in_sends_the_code_and_records_it_until_answered() {
    let (mut s, kp) = stores().await;
    let out = apply(
        &mut s,
        Intent::WebSignIn {
            machine: "m".into(),
            code: "K7QM-4XPA".into(),
        },
        &kp,
        ctx(),
    );
    assert!(matches!(
        out.sends.as_slice(),
        [Send { machine, msg: PhoneToBridge::WebSignIn(m) }]
            if machine == "m" && m.code == "K7QM-4XPA"
    ));
    assert!(out.ui_changed, "the sign-in screen reads the entry back");
    assert_eq!(s.ui.web_sign_in["m"].code, "K7QM-4XPA");
    assert_eq!(
        s.ui.web_sign_in["m"].state,
        client_core::stores::ui::WebSignInState::Sending,
        "silence is not a verdict; the screen times itself out"
    );
}

#[tokio::test]
async fn clearing_a_web_sign_in_sends_nothing_and_reports_its_own_change() {
    let (mut s, kp) = stores().await;
    apply(
        &mut s,
        Intent::WebSignIn {
            machine: "m".into(),
            code: "K7QM-4XPA".into(),
        },
        &kp,
        ctx(),
    );

    let out = apply(&mut s, Intent::ClearWebSignIn { machine: "m".into() }, &kp, ctx());
    assert!(out.sends.is_empty());
    assert!(out.ui_changed);
    assert!(!s.ui.web_sign_in.contains_key("m"));

    // Nothing left to forget: no re-fetch for a screen that is gone.
    let out = apply(&mut s, Intent::ClearWebSignIn { machine: "m".into() }, &kp, ctx());
    assert!(!out.ui_changed);
}

#[tokio::test]
async fn requesting_the_web_browsers_sends_a_bare_request() {
    let (mut s, kp) = stores().await;
    let out = apply(
        &mut s,
        Intent::RequestWebBrowsers { machine: "m".into() },
        &kp,
        ctx(),
    );
    assert!(matches!(
        out.sends.as_slice(),
        [Send { machine, msg: PhoneToBridge::WebBrowsersRequest(_) }] if machine == "m"
    ));
    assert!(!out.ui_changed, "nothing changed until the bridge answers");
}

#[tokio::test]
async fn signing_out_a_browser_sends_it_and_drops_the_row_at_once() {
    let (mut s, kp) = stores().await;
    s.ui.set_web_browsers("m", vec![protocol::events::WebBrowserInfo {
        id: "0123456789abcdef".into(),
        by: "npub1owner".into(),
        since_ms: 1,
        last_seen_ms: 2,
        expires_ms: 3,
        peer: "192.168.1.20".into(),
        agent: "Mozilla/5.0".into(),
    }]);

    let out = apply(
        &mut s,
        Intent::SignOutWebBrowser {
            machine: "m".into(),
            id: "0123456789abcdef".into(),
        },
        &kp,
        ctx(),
    );
    assert!(matches!(
        out.sends.as_slice(),
        [Send { machine, msg: PhoneToBridge::WebBrowserSignOut(m) }]
            if machine == "m" && m.id == "0123456789abcdef"
    ));
    assert!(out.ui_changed, "the row left before the answer");
    assert!(s.ui.web_browsers["m"].is_empty());

    // An id the list no longer holds still goes to the bridge — its
    // answer is what the screen trusts — but moves nothing here.
    let out = apply(
        &mut s,
        Intent::SignOutWebBrowser {
            machine: "m".into(),
            id: "0123456789abcdef".into(),
        },
        &kp,
        ctx(),
    );
    assert_eq!(out.sends.len(), 1);
    assert!(!out.ui_changed);
}

/// Screens ask each time they open; the profiles, which the bridge
/// pushes on every change, are not asked for twice.
#[tokio::test]
async fn screens_reopening_ask_again_for_everything_not_pushed() {
    let (mut s, kp) = stores().await;
    let mut sent = 0;
    let mut open_screen = |s: &mut CoreStores, now: u64| {
        for intent in [
            Intent::RequestProviderProfiles { machine: "m".into() },
            Intent::RequestModels { machine: "m".into(), agent: "claude".into() },
        ] {
            sent += apply(s, intent, &kp, IntentCtx { now, visible: true, terminal_transport: InputTransport::Direct }).sends.len();
        }
        std::mem::take(&mut sent)
    };
    assert_eq!(open_screen(&mut s, 0), 2, "first open asks for both");
    assert_eq!(open_screen(&mut s, 1_000), 0, "both still in flight");
    s.machines.fetches.answered("m", Fetch::ProviderProfiles);
    s.machines.fetches.answered("m", Fetch::Models("claude".into()));
    assert_eq!(open_screen(&mut s, 3_000), 1, "the model list is asked for again; profiles are pushed");
    s.machines.fetches.forget_all();
    assert_eq!(open_screen(&mut s, 4_000), 2, "a reconnect asks again");
}

#[tokio::test]
async fn create_folder_sends_the_request_with_its_id() {
    let (mut s, kp) = stores().await;
    let out = apply(
        &mut s,
        Intent::CreateFolder {
            machine: "m".into(),
            path: "sub/dir".into(),
            root: Some("/ws".into()),
            request_id: "req-1".into(),
        },
        &kp,
        ctx(),
    );
    assert!(matches!(
        out.sends.as_slice(),
        [Send { machine, msg: PhoneToBridge::CreateFolder(m) }]
            if machine == "m"
                && m.path == "sub/dir"
                && m.root.as_deref() == Some("/ws")
                && m.request_id == "req-1"
    ));
}

#[tokio::test]
async fn set_option_maps_to_one_command() {
    let (mut s, kp) = stores().await;
    let out = apply(
        &mut s,
        Intent::SetOption {
            machine: "m".into(),
            session_id: "s1".into(),
            option: SessionOption::Mode,
            value: "acceptEdits".into(),
        },
        &kp,
        ctx(),
    );
    assert!(matches!(
        out.sends.as_slice(),
        [Send { msg: PhoneToBridge::SetOption(m), .. }]
            if m.option == SessionOption::Mode && m.value == "acceptEdits"
    ));
    assert!(out.persist.is_empty()); // the CONFIRM writes state, not the request
}

#[tokio::test]
async fn personas_are_asked_for_a_session_or_the_whole_machine() {
    let (mut s, kp) = stores().await;
    for session_id in [Some("s1".to_string()), None] {
        let out = apply(
            &mut s,
            Intent::RequestPersonas { machine: "m".into(), agent: "opencode".into(), session_id: session_id.clone() },
            &kp,
            ctx(),
        );
        assert!(matches!(
            out.sends.as_slice(),
            [Send { msg: PhoneToBridge::PersonasRequest(m), .. }] if m.agent == "opencode" && m.session_id == session_id
        ));
    }
}

#[tokio::test]
async fn machine_relays_and_new_session_defaults_are_set_per_machine() {
    let (mut s, kp) = stores().await;
    s.machines.register_machine("m", "laptop", None, None, &["wss://a.example".to_string()]);

    let out = apply(
        &mut s,
        Intent::SetMachineRelays { machine: "m".into(), relays: vec!["wss://b.example".into()] },
        &kp,
        ctx(),
    );
    assert_eq!(out.persist, vec![StoreId::Machines]);
    assert_eq!(s.relay_set(), vec!["wss://b.example"]);
    // an empty list would strand the machine: ignored
    let out = apply(&mut s, Intent::SetMachineRelays { machine: "m".into(), relays: vec![] }, &kp, ctx());
    assert_eq!(out, IntentResult::default());

    apply(&mut s, Intent::SetDefaultAgent { machine: "m".into(), agent: Some("opencode".into()) }, &kp, ctx());
    let out = apply(
        &mut s,
        Intent::SetAgentDefaults {
            machine: "m".into(),
            agent: "opencode".into(),
            mode: "build".into(),
            effort: String::new(),
            model: "gpt".into(),
            persona: "review".into(),
        },
        &kp,
        ctx(),
    );
    assert_eq!(out.persist, vec![StoreId::Machines]);
    let m = s.machines.machine("m").unwrap();
    assert_eq!(m.default_agent.as_deref(), Some("opencode"));
    assert_eq!(m.agent_defaults["opencode"].model, "gpt");
    assert_eq!(m.agent_defaults["opencode"].persona, "review");
}

#[tokio::test]
async fn every_settings_intent_mutates_the_store_and_persists() {
    let (mut s, kp) = stores().await;

    let out = apply(&mut s, Intent::SetBlossomServer("https://blossom.example".into()), &kp, ctx());
    assert_eq!(out.persist, vec![StoreId::Settings]);
    assert_eq!(s.settings.data.blossom_server, "https://blossom.example");

    apply(&mut s, Intent::SetShowUsageBadge(false), &kp, ctx());
    assert!(!s.settings.data.show_usage_badge);

    apply(&mut s, Intent::SetShowCommitBadge(false), &kp, ctx());
    assert!(!s.settings.data.show_commit_badge);
}

#[tokio::test]
async fn select_session_returns_the_cdx_026c_effect_and_moves_the_ui() {
    let (mut s, kp) = stores().await;
    s.ui.mark_session_unread("m", "s1");
    let out = apply(
        &mut s,
        Intent::SelectSession {
            machine: "m".into(),
            session_id: Some("s1".into()),
        },
        &kp,
        ctx(),
    );
    assert_eq!(s.ui.selected_session.as_deref(), Some("s1"));
    assert!(!s.ui.is_session_unread("m", "s1")); // visible → cleared
    assert_eq!(
        out.ui_effects,
        vec![UiEffect::SessionViewed {
            machine: "m".into(),
            session_id: "s1".into()
        }]
    );
}

#[tokio::test]
async fn quick_prompt_crud_persists_only_on_a_real_change() {
    let (mut s, kp) = stores().await;
    let add = apply(
        &mut s,
        Intent::AddQuickPrompt {
            id: "qp-1".into(),
            label: "Go".into(),
            text: "continue".into(),
        },
        &kp,
        ctx(),
    );
    assert_eq!(add.persist, vec![StoreId::QuickPrompts]);
    // empty label → rejected → no persist
    let rej = apply(
        &mut s,
        Intent::AddQuickPrompt {
            id: "qp-2".into(),
            label: "  ".into(),
            text: "x".into(),
        },
        &kp,
        ctx(),
    );
    assert!(rej.persist.is_empty());
    // unknown id remove → no persist
    let miss = apply(
        &mut s, Intent::RemoveQuickPrompt { id: "nope".into() }, &kp, ctx());
    assert!(miss.persist.is_empty());
}
