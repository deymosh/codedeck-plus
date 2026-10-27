use super::*;

/// The next frame of `kind` (`REQ`, `EVENT`, …), skipping the others.
async fn next_frame_of(mock: &mut MockRelay, kind: &str) -> Vec<serde_json::Value> {
    for _ in 0..20 {
        let frame = mock.next_frame().await;
        let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
        if v[0] == kind {
            return v;
        }
    }
    panic!("no {kind} frame");
}

/// The backup look's REQ: answered with `events` then EOSE. Returns the
/// subscription's id.
async fn answer_backup_req(mock: &mut MockRelay, me: &str, events: &[serde_json::Value]) -> String {
    loop {
        let req = next_frame_of(mock, "REQ").await;
        let sub = req[1].as_str().unwrap().to_string();
        if req[2]["#d"].is_array() {
            assert_eq!(req[2]["kinds"], serde_json::json!([30078]));
            assert_eq!(req[2]["authors"], serde_json::json!([me]));
            for e in events {
                mock.push(serde_json::json!(["EVENT", sub, e]).to_string());
            }
            mock.push(format!(r#"["EOSE","{sub}"]"#));
            return sub;
        }
        mock.push(format!(r#"["EOSE","{sub}"]"#));
    }
}

/// Backup turned on with `mock` as its relay, holding nothing yet: the
/// core saves its own, which the relay takes. Returns the backup
/// subscription's id.
async fn backup_on(core: &Core, mock: &mut MockRelay, me: &str) -> String {
    core.dispatch(Intent::SetBackupRelay(mock.url.clone())).await;
    let sub = answer_backup_req(mock, me, &[]).await;
    let event = next_frame_of(mock, "EVENT").await[1].clone();
    mock.push(serde_json::json!(["OK", event["id"], true, ""]).to_string());
    wait_for_async(|| {
        let core = core.clone();
        async move { core.settings_view().await.unwrap().backup.saved_at.is_some() }
    })
    .await;
    sub
}

#[tokio::test]
async fn the_backup_relay_hears_only_the_backup_and_the_bridge_relays_never_do() {
    LocalSet::new()
        .run_until(async {
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let mut bridge_relay = mock_relay().await;
            let mut backup_relay = mock_relay().await;
            let mut state = client_core::stores::machines::MachinesState::default();
            state.register_machine(&machine.pubkey_hex, "laptop", None, None, &[bridge_relay.url.clone()]);
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let ports = CorePorts { kv: Rc::new(kv), ..CorePorts::default() };
            let core = core_for_ports(&bridge_relay, &phone, Rc::new(Spy::default()), ports).await;
            core.start();
            core.dispatch(Intent::SetBackupRelay(backup_relay.url.clone())).await;
            let req = next_frame_of(&mut backup_relay, "REQ").await;
            assert!(req[2]["#d"].is_array(), "the backup relay is asked for the backup: {req:?}");
            let sub = req[1].as_str().unwrap();
            backup_relay.push(format!(r#"["EOSE","{sub}"]"#));
            while let Some(frame) = backup_relay.frame_within(Duration::from_millis(400)).await {
                assert!(!frame.starts_with(r#"["REQ""#), "the backup relay sees what the phone follows: {frame}");
            }
            while let Some(frame) = bridge_relay.frame_within(Duration::from_millis(200)).await {
                let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
                assert!(v[0] != "REQ" || v[2].get("#d").is_none(), "a bridge relay sees the backup's REQ: {frame}");
            }
        })
        .await;
}

#[tokio::test]
async fn a_deletion_on_another_device_turns_backup_off_here() {
    LocalSet::new()
        .run_until(async {
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let mut mock = mock_relay().await;
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;
            core.start();
            let sub = backup_on(&core, &mut mock, &phone.pubkey_hex).await;
            assert!(settings_backup(&core).await.relay.is_some());
            // Another device deletes it: the empty version takes its place.
            let signer = crate::signer::LocalSigner(phone.clone());
            let removed = crate::backup::seal_removed(&signer, 5_000).await.unwrap();
            mock.push(serde_json::json!(["EVENT", sub, removed]).to_string());
            wait_for_async(|| {
                let core = core.clone();
                async move {
                    matches!(
                        core.settings_view().await.unwrap().backup.status,
                        crate::backup::BackupStatus::Failed { .. }
                    )
                }
            })
            .await;
            let backup = settings_backup(&core).await;
            assert_eq!(backup.relay, None);
            assert!(matches!(backup.status, crate::backup::BackupStatus::Failed { reason } if reason.contains("another device")));
        })
        .await;
}

#[tokio::test]
async fn a_device_joining_after_a_deletion_saves_its_own() {
    LocalSet::new()
        .run_until(async {
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let mut mock = mock_relay().await;
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;
            core.start();
            let signer = crate::signer::LocalSigner(phone.clone());
            let removed = crate::backup::seal_removed(&signer, 900).await.unwrap();
            core.dispatch(Intent::SetBackupRelay(mock.url.clone())).await;
            answer_backup_req(&mut mock, &phone.pubkey_hex, &[serde_json::to_value(&removed).unwrap()]).await;
            let saved = next_frame_of(&mut mock, "EVENT").await[1].clone();
            assert_eq!(saved["kind"], 30078);
            assert!(!saved["content"].as_str().unwrap().is_empty());
            assert!(saved["created_at"].as_u64().unwrap() > 900, "dated past the empty version");
            assert!(settings_backup(&core).await.relay.is_some());
        })
        .await;
}

#[tokio::test]
async fn a_backup_relay_ending_the_subscription_shows_as_a_failure() {
    LocalSet::new()
        .run_until(async {
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let mut mock = mock_relay().await;
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;
            core.start();
            let sub = backup_on(&core, &mut mock, &phone.pubkey_hex).await;
            mock.push(serde_json::json!(["CLOSED", sub, "restricted: members only"]).to_string());
            wait_for_async(|| {
                let core = core.clone();
                async move {
                    matches!(
                        core.settings_view().await.unwrap().backup.status,
                        crate::backup::BackupStatus::Failed { .. }
                    )
                }
            })
            .await;
            let backup = settings_backup(&core).await;
            assert!(backup.relay.is_some(), "backup stays on, and is asked for again later");
            assert!(matches!(backup.status, crate::backup::BackupStatus::Failed { reason } if reason.contains("members only")));
        })
        .await;
}

async fn settings_backup(core: &Core) -> crate::view::BackupView {
    core.settings_view().await.unwrap().backup
}

#[tokio::test]
async fn a_backup_saved_by_one_phone_restores_the_machines_on_another() {
    LocalSet::new()
        .run_until(async {
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();

            // The old phone, paired with a machine, turns the backup on.
            let mut first = mock_relay().await;
            let mut state = client_core::stores::machines::MachinesState::default();
            // Names with spaces: base64 ciphertext can never contain them by chance.
            state.register_machine(&machine.pubkey_hex, "my laptop", Some("Work lab".into()), None, &[first.url.clone()]);
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let old_keys = MemoryKeyStore::default();
            let ports = CorePorts { kv: Rc::new(kv), session_keys: Some(Rc::new(old_keys.clone())), ..CorePorts::default() };
            let old = core_for_ports(&first, &phone, Rc::new(Spy::default()), ports).await;
            old.start();
            old.dispatch(Intent::SetBackupRelay(first.url.clone())).await;
            // Nothing on the relay yet: this phone's is saved.
            answer_backup_req(&mut first, &phone.pubkey_hex, &[]).await;
            let event = next_frame_of(&mut first, "EVENT").await[1].clone();
            assert_eq!(event["kind"], 30078);
            let wire = event.to_string();
            let old_secret = old_keys.ring().current.keypair.secret_hex();
            assert!(!wire.contains("my laptop") && !wire.contains("Work lab") && !wire.contains(&machine.pubkey_hex));
            assert!(!wire.contains(&old_secret));
            first.push(serde_json::json!(["OK", event["id"], true, ""]).to_string());
            wait_for_async(|| {
                let old = old.clone();
                async move { old.settings_view().await.unwrap().backup.saved_at.is_some() }
            })
            .await;
            let saved = settings_backup(&old).await;
            assert_eq!(saved.relay.as_deref(), Some(first.url.as_str()));
            assert!(saved.saved_at.is_some());

            // Another device with the same identity turns backup on: the
            // machine is merged in at once, with no question asked.
            let mut second = mock_relay().await;
            let new_keys = MemoryKeyStore::default();
            let ports = CorePorts { session_keys: Some(Rc::new(new_keys.clone())), ..CorePorts::default() };
            let new = core_for_ports(&second, &phone, Rc::new(Spy::default()), ports).await;
            new.start();
            new.dispatch(Intent::SetBackupRelay(second.url.clone())).await;
            answer_backup_req(&mut second, &phone.pubkey_hex, &[event]).await;
            // The backup's "the relay answered" flag is private, and both the
            // merged machine and an Idle status can be observed while its EOSE
            // is still in flight, so no view names the point where a save is
            // allowed to run. Give the answer time to be folded in.
            settle().await;
            let machines = new.machines_view().await.machines;
            let restored = &machines[&machine.pubkey_hex];
            assert_eq!((restored.label.as_deref(), restored.relays.clone()), (Some("Work lab"), vec![first.url.clone()]));
            assert!(matches!(settings_backup(&new).await.status, crate::backup::BackupStatus::Idle));
            // Its session keys stay its own: it is a client of its own.
            assert_ne!(new_keys.ring().current.keypair.secret_hex(), old_secret);

            // Its own edit goes into what it saves, the merged machine with it.
            new.dispatch(Intent::SetDirectEndpoints {
                machine: machine.pubkey_hex.clone(),
                endpoints: vec!["wss://laptop.lan:7447".into()],
            })
            .await;
            new.dispatch(Intent::BackupNow).await;
            let saved = next_frame_of(&mut second, "EVENT").await[1].clone();
            let plain = protocol::crypto::decrypt_from(&phone.secret_key, &phone.pubkey_hex, saved["content"].as_str().unwrap()).unwrap();
            let doc = client_core::stores::backup::decode_backup(&plain).unwrap();
            assert_eq!(doc.machines.len(), 1);
            assert_eq!(doc.machines[0].direct_endpoints, ["wss://laptop.lan:7447"]);
            assert!(!plain.contains(&old_secret) && !plain.contains("secretHex"), "no session keys in the backup");
        })
        .await;
}

#[tokio::test]
async fn a_relay_address_the_phone_may_not_dial_is_refused() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;
            core.dispatch(Intent::SetBackupRelay("ws://plain.example".into())).await;
            let backup = settings_backup(&core).await;
            assert_eq!(backup.relay, None);
            assert!(matches!(backup.status, crate::backup::BackupStatus::Failed { .. }));
        })
        .await;
}
