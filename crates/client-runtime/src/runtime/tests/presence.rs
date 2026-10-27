use super::*;

// --- what the client watches: the bridge sends live text only for it ---

/// Opening a session tells its bridge to send that session's live text, and
/// leaving it tells the bridge to stop; both after the coalescing window.
#[tokio::test]
async fn the_session_on_screen_is_what_the_bridge_is_told() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let key = SessionKey { keypair: generate_keypair(), expires_at: 1_000 + 80 * 24 * 3600 };
            let core = core_watched_by(&mock, &phone, &key, &machine).await;
            eose_all(&mut mock).await;
            let refresh = next_command_via(&mut mock, &phone, key.pubkey_hex(), &machine).await;
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");

            core.dispatch(Intent::SelectSession { machine: machine.pubkey_hex.clone(), session_id: Some("s1".into()) }).await;
            let opened = presences_within(&mut mock, key.pubkey_hex(), &machine, Duration::from_millis(700)).await;
            assert_eq!(opened.len(), 1, "{opened:?}");
            assert!(!opened[0].away);
            assert_eq!(opened[0].watching.as_deref(), Some("s1"), "the session on screen");

            core.dispatch(Intent::SelectSession { machine: machine.pubkey_hex.clone(), session_id: None }).await;
            let left = presences_within(&mut mock, key.pubkey_hex(), &machine, Duration::from_millis(700)).await;
            assert_eq!(left.len(), 1, "{left:?}");
            assert_eq!(left[0].watching, None, "nothing is on screen any more");
        })
        .await;
}

/// Backgrounding the app stops its live text: the bridge is told nothing is
/// on screen, and told again which session when the app comes back.
#[tokio::test]
async fn backgrounding_the_app_stops_the_live_text() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let key = SessionKey { keypair: generate_keypair(), expires_at: 1_000 + 80 * 24 * 3600 };
            let core = core_watched_by(&mock, &phone, &key, &machine).await;
            eose_all(&mut mock).await;
            let refresh = next_command_via(&mut mock, &phone, key.pubkey_hex(), &machine).await;
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");
            core.dispatch(Intent::SelectSession { machine: machine.pubkey_hex.clone(), session_id: Some("s1".into()) }).await;
            assert_eq!(presences_within(&mut mock, key.pubkey_hex(), &machine, Duration::from_millis(700)).await.len(), 1);

            core.pause();
            // Hiding is debounced (VISIBILITY_DEBOUNCE_MS), and the change is
            // then coalesced (WATCH_SETTLE_MS) before it is sent.
            let hidden = presences_within(&mut mock, key.pubkey_hex(), &machine, Duration::from_millis(1400)).await;
            assert_eq!(hidden.len(), 1, "{hidden:?}");
            assert_eq!(hidden[0].watching, None, "a backgrounded app shows nothing");

            core.resume();
            let back = presences_within(&mut mock, key.pubkey_hex(), &machine, Duration::from_millis(700)).await;
            assert_eq!(back.len(), 1, "{back:?}");
            assert_eq!(back[0].watching.as_deref(), Some("s1"), "the session is on screen again");
        })
        .await;
}

/// Flicking through sessions is one `presence`, for the one left on screen.
#[tokio::test]
async fn switching_sessions_quickly_sends_one_presence() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let key = SessionKey { keypair: generate_keypair(), expires_at: 1_000 + 80 * 24 * 3600 };
            let core = core_watched_by(&mock, &phone, &key, &machine).await;
            eose_all(&mut mock).await;
            let refresh = next_command_via(&mut mock, &phone, key.pubkey_hex(), &machine).await;
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");

            for session in ["s1", "s2", "s3"] {
                core.dispatch(Intent::SelectSession {
                    machine: machine.pubkey_hex.clone(),
                    session_id: Some(session.into()),
                })
                .await;
            }
            let sent = presences_within(&mut mock, key.pubkey_hex(), &machine, Duration::from_millis(700)).await;
            assert_eq!(sent.len(), 1, "one presence for the whole burst: {sent:?}");
            assert_eq!(sent[0].watching.as_deref(), Some("s3"), "the one left on screen");
        })
        .await;
}
