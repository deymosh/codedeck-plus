//! Intent — the closed set of user actions. `apply`
//! folds one into the `CoreStores` and returns an [`IntentResult`]: commands to
//! sign+publish, stores to persist, and the transport-affecting effects
//! (`resubscribe`, a new relay list, a Tor toggle).
//!
//! Covers the session-interaction commands, the pure store actions, the outbox
//! send/retry lifecycle, the optimistic delete + undo, the pairing flow (and
//! its inverse, forgetting a paired machine), and the session image upload
//! (Blossom-first, relay-chunk fallback).

use client_core::delete_controller::DeleteEffect;
use client_core::stores::outbox::OutboxState;
use client_core::stores::pairing::{
    parse_manual_pair, parse_pairing_url, pairing_reducer, PairingEvent, PAIR_ACK_TIMEOUT_MS,
};
use client_core::stores::settings::SettingsEffect;
use client_core::stores::ui::{UiEffect, UndoToast};
use protocol::commands::{
    BareMsg, CreateFolderMsg, CreateSessionMsg, InputMsg, ModelsRequestMsg, PermissionResponseMsg,
    PhoneToBridge, PlanResponseMsg, ProviderProfileWrite, QuestionAnswer, QuestionResponseMsg,
    SessionIdMsg, SetCredentialsMsg, SetDeviceConfigMsg, SetOptionMsg, SetProviderProfileMsg,
    VersionFields,
};
use protocol::common::{CredentialValues, DeviceConfig, SessionOption};
use serde::{Deserialize, Serialize};

use crate::dispatch::{apply_pairing_effects, PairDeadline, Send, StoreId};
use crate::stores::CoreStores;

/// The `ui.responded_cards` key for question `index` of the ask `request_id`
/// — per question, so a multi-question card can advance question by question.
pub fn question_card_key(request_id: &str, index: u32) -> String {
    format!("{request_id}:q{index}")
}

/// Arm / clear the delete-controller's 4 s undo timer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UndoTimer {
    Arm { ms: u64 },
    Clear,
}

/// A send whose publish outcome must settle an outbox item.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboxSend {
    pub id: String,
    pub machine: String,
    pub msg: PhoneToBridge,
}

/// A session image the loop uploads then attaches to `session_id`'s input.
/// Bytes + mime, never a platform type — the UI decodes whatever
/// picker/camera/resize API it has into this shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionImageSend {
    pub machine: String,
    pub session_id: String,
    pub text: String,
    pub image: Vec<u8>,
    pub filename: String,
    pub mime_type: String,
}

/// Ambient inputs `apply` needs.
#[derive(Debug, Clone, Copy)]
pub struct IntentCtx {
    pub now: u64,
    /// App visibility — `SelectSession` only clears unread while visible.
    pub visible: bool,
}

#[derive(Debug, Default, PartialEq)]
pub struct IntentResult {
    pub sends: Vec<Send>,
    pub persist: Vec<StoreId>,
    /// The relay subscription authors filter changed — resubscribe.
    pub resubscribe: bool,
    /// A new relay list — the loop reconfigures the transport + DM/Marmot subs.
    pub relays_changed: Option<Vec<String>>,
    /// Tor toggled — the loop re-inits the transport proxy.
    pub tor_changed: Option<bool>,
    /// CDX-026c: surfaces so the loop can cancel a surface's notifications.
    pub ui_effects: Vec<UiEffect>,
    /// A `send` whose publish outcome settles an outbox item (`SendInput` /
    /// `RetryOutboxItem`).
    pub outbox_send: Option<OutboxSend>,
    /// Arm / clear the CDX-040 pair-ack deadline.
    pub pair_deadline: Option<PairDeadline>,
    /// The pair flow ended: `Some(true)` paired, `Some(false)` nack / timeout.
    pub pairing_settled: Option<bool>,
    /// CDX-028 one-QR mesh join.
    pub mesh_join: Option<(String, String)>,
    /// Arm / clear the delete-controller undo timer.
    pub undo_timer: Option<UndoTimer>,
    /// `(peer, text)` — the loop wraps + publishes this NIP-17 DM (async).
    pub dm_send: Option<(String, String)>,
    /// `(peer, text, image)` — the loop uploads the image then sends the DM.
    pub dm_image_send: Option<(String, String, Vec<u8>)>,
    /// The loop uploads a session image (Blossom-first, chunk fallback) then
    /// publishes the `upload-image` command.
    pub session_image_send: Option<SessionImageSend>,
    /// `welcome_id` — the loop joins the MLS group engine-side.
    pub marmot_accept: Option<String>,
    /// `(group_id, text)` — the loop encrypts + publishes this Marmot message.
    pub marmot_send: Option<(String, String)>,
    /// `peer_pubkey` — the loop fetches their KeyPackage and creates the group.
    pub marmot_start_chat: Option<String>,
    /// `pending_sessions` changed — not persisted, so this is the only signal
    /// a `PendingSessionsView` consumer gets that a re-fetch is worth doing.
    pub pending_sessions_changed: bool,
    /// `stores.ui` changed in a way worth a `UiView` re-fetch — mirrors
    /// `RouteResult::ui_changed`.
    pub ui_changed: bool,
    /// `(machine, session_id)` pairs whose transcript rows the loop must
    /// drop from the `TranscriptStore` — mirrors `RouteResult::transcript_removed`
    /// (there: remote tombstones; here: `RemoveMachine` forgetting every
    /// session the machine had).
    pub transcript_removed: Vec<(String, String)>,
}

impl IntentResult {
    fn send(&mut self, machine: &str, msg: PhoneToBridge) {
        self.sends.push(Send {
            machine: machine.to_string(),
            msg,
        });
    }
    fn persist(&mut self, id: StoreId) {
        if !self.persist.contains(&id) {
            self.persist.push(id);
        }
    }
}

/// The user action. Serializable so a binding can pass it across the FFI.
/// Serde shape: externally tagged (`{"SendInput": {...}}` / `{"UndoDelete":
/// null}`), `camelCase` field names within each variant. The Android app never
/// sees this JSON (it crosses `client_ffi::UniffiIntent` instead), but a
/// binding needing a stable JSON shape can start from this rather than
/// hand-rolling its own encoding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Intent {
    // --- the outbox path ---
    /// Send session input. `input_id` is the runtime's generated id — it keys
    /// the outbox item and the `input-ack` correlation.
    SendInput {
        machine: String,
        session_id: String,
        text: String,
        input_id: String,
    },
    /// Re-send a `Failed` outbox item (same id + text, `attempts` bumped).
    RetryOutboxItem {
        machine: String,
        id: String,
    },
    /// Attach an image to `session_id`'s next input (CDX-029). The loop
    /// uploads it to Blossom, falling back to relay chunks, then publishes the
    /// `upload-image` command — no outbox item, no local echo (the transcript
    /// shows it once the bridge injects it, like any other output).
    SendSessionImage(SessionImageSend),

    // --- optimistic delete (4 s undo) ---
    DeleteSession {
        machine: String,
        session_id: String,
        /// Undo-toast label; falls back to the session title / slug.
        label: Option<String>,
    },
    UndoDelete,

    // --- pairing (CDX-013 / 040 / 041 / 028) ---
    /// Send a `pair-request` for a scanned/pasted `codedeck://pair` URL.
    BeginPairing {
        url: String,
        label: String,
    },
    /// Manual npub + token fallback.
    BeginManualPairing {
        npub: String,
        token: String,
        label: String,
    },
    /// CDX-013: stage a deep-link URL for explicit confirmation.
    StagePairing {
        url: String,
    },
    ConfirmStagedPairing {
        label: String,
    },
    DismissStagedPairing,
    ResetPairing,

    /// Forget a paired machine: drops it (and its sessions) from local state
    /// and the subscription authors filter. Purely local — there is no wire
    /// message for this (the bridge has no concept of being "unpaired"; it
    /// simply stops hearing from a phone that stopped listening to it).
    RemoveMachine {
        pubkey_hex: String,
    },

    // --- session commands ---
    /// Answer a permission request with one of its advertised options.
    RespondPermission {
        machine: String,
        session_id: String,
        request_id: String,
        option_id: String,
    },
    /// Answer question `index` of the ask `request_id`.
    AnswerQuestion {
        machine: String,
        session_id: String,
        request_id: String,
        #[specta(type = specta_typescript::Number)]
        index: u32,
        answer: QuestionAnswer,
    },
    /// Answer a plan approval with one of its advertised options.
    RespondPlan {
        machine: String,
        session_id: String,
        request_id: String,
        option_id: String,
    },
    /// Change a session's mode / effort / model.
    SetOption {
        machine: String,
        session_id: String,
        option: SessionOption,
        value: String,
    },
    Interrupt {
        machine: String,
        session_id: String,
    },
    CloseSession {
        machine: String,
        session_id: String,
    },
    CreateSession {
        machine: String,
        agent: String,
        cwd: Option<String>,
        create_cwd: Option<bool>,
        mode: Option<String>,
        effort: Option<String>,
        model: Option<String>,
        provider_id: Option<String>,
        test_session: Option<bool>,
    },
    RefreshSessions {
        machine: String,
    },
    RequestModels {
        machine: String,
        agent: String,
    },
    RequestUsage {
        machine: String,
        session_id: String,
    },
    RequestGsd {
        machine: String,
        session_id: String,
    },
    /// Store credentials on the bridge host (CDX-011) for `agent`, or for the
    /// bridge itself when `None`: a string sets an id, `null` clears it, an
    /// id not listed is kept. Secrets: never logged.
    SetCredentials {
        machine: String,
        agent: Option<String>,
        values: CredentialValues,
    },
    /// Upsert (`profile: Some`) or delete (`profile: None`) one custom
    /// provider profile stored bridge-side (CDX-062).
    SetProviderProfile {
        machine: String,
        profile_id: String,
        profile: Option<ProviderProfileWrite>,
    },
    RequestProviderProfiles {
        machine: String,
    },
    /// Test-device config (Phase 5d, mesh autonomous test loop).
    SetDeviceConfig {
        machine: String,
        config: DeviceConfig,
    },
    /// Create a new project folder under a workspace root (and `git init` it,
    /// bridge-side). Answered with `CoreEvent::FolderAck`, matched by
    /// `request_id` — the caller mints it (a UUID is fine; the bridge only
    /// ever echoes it back).
    CreateFolder {
        machine: String,
        path: String,
        root: Option<String>,
        request_id: String,
    },

    // --- pure store actions ---
    SelectSession {
        machine: String,
        session_id: Option<String>,
    },
    SelectDmPeer {
        peer: Option<String>,
    },
    MarkDmRead {
        peer: String,
    },
    /// Open (or create) a NIP-17 conversation for an npub / hex peer.
    StartDmConversation {
        peer_input: String,
    },
    /// Send a NIP-17 DM (the loop wraps + publishes).
    SendDm {
        peer: String,
        text: String,
    },
    /// Encrypt + upload an image to Blossom, then send it as a DM (the ref line
    /// `<url> key=… iv=…` appended to `text`). The loop does the async work.
    SendDmImage {
        peer: String,
        text: String,
        image: Vec<u8>,
    },
    SelectMarmotGroup {
        group_id: Option<String>,
    },
    MarkMarmotRead {
        group_id: String,
    },
    /// Join an MLS group from a pending welcome (the loop calls the engine).
    AcceptMarmotWelcome {
        welcome_id: String,
    },
    /// Send a Marmot (MLS) group message; the loop encrypts + publishes.
    SendMarmotMessage {
        group_id: String,
        text: String,
    },
    /// Open a 1:1 Marmot chat with a peer: an existing conversation is reused,
    /// never duplicated; otherwise the loop fetches their KeyPackage and asks
    /// the engine to create the group and publish the welcome.
    StartMarmotChat {
        peer_pubkey: String,
    },
    AddRelay {
        url: String,
    },
    RemoveRelay {
        url: String,
    },
    /// Merge relays learned from a pairing URL. Not itself user-facing on the
    /// pairing path (that already merges internally when a candidate settles)
    /// — kept for a Settings UI that wants to bulk-add without a per-URL loop.
    AddRelays {
        urls: Vec<String>,
    },
    SetTorEnabled(bool),
    SetStayConnected(bool),
    SetMeshTestTarget(bool),
    SetBlossomServer(String),
    SetNotificationsEnabled(bool),
    /// Preferred mode / effort / model for new sessions (agent ids; empty =
    /// the agent's default).
    SetDefaultMode(String),
    SetDefaultEffort(String),
    SetDefaultModel(String),
    SetUiScale(f64),
    SetShowUsageBadge(bool),
    SetShowCommitBadge(bool),
    AddQuickPrompt {
        id: String,
        label: String,
        text: String,
    },
    UpdateQuickPrompt {
        id: String,
        label: String,
        text: String,
    },
    RemoveQuickPrompt {
        id: String,
    },
    /// User dismisses a failed pending-session card.
    DismissPendingSession {
        pending_id: String,
    },
    /// Records which plan-approval option the user tapped (its option id) so
    /// the card can label itself before the bridge resolves it — sent
    /// ALONGSIDE the actual answer (`RespondPlan`), not instead of it.
    SetPlanApprovalChoice {
        card_id: String,
        key: String,
    },
}

pub fn apply(
    stores: &mut CoreStores,
    intent: Intent,
    identity: &protocol::crypto::Keypair,
    ctx: IntentCtx,
) -> IntentResult {
    let mut r = IntentResult::default();
    let v = VersionFields::default;
    match intent {
        Intent::SendInput {
            machine,
            session_id,
            text,
            input_id,
        } => {
            let item =
                OutboxState::new_input(&input_id, &machine, &session_id, &text, ctx.now);
            stores.outbox.begin_publish(item);
            r.persist(StoreId::Outbox);
            // Replying to a session means the user saw it — clear its dot; and
            // an untitled session takes its first user message as a stopgap
            // title until the bridge authors a topical one.
            stores.ui.clear_session_unread(&machine, &session_id);
            r.ui_changed = true;
            stores
                .machines
                .note_first_user_message(&machine, &session_id, &text);
            r.persist(StoreId::Machines);
            r.outbox_send = Some(OutboxSend {
                id: input_id.clone(),
                machine,
                msg: PhoneToBridge::Input(InputMsg {
                    version: v(),
                    session_id,
                    text,
                    input_id: Some(input_id),
                }),
            });
        }
        Intent::RetryOutboxItem { machine, id } => {
            // `mark_retry` re-queues the item itself (Pending, attempts+1) and
            // returns it — only for a `Failed` item, else `None`.
            if let Some(item) = stores.outbox.mark_retry(&id, ctx.now) {
                r.persist(StoreId::Outbox);
                r.outbox_send = Some(OutboxSend {
                    id,
                    machine,
                    msg: PhoneToBridge::Input(InputMsg {
                        version: v(),
                        session_id: item.session_id,
                        text: item.text,
                        input_id: Some(item.id),
                    }),
                });
            }
        }

        Intent::SendSessionImage(send) => {
            r.session_image_send = Some(send);
        }

        Intent::DeleteSession {
            machine,
            session_id,
            label,
        } => {
            let snapshot = stores.machines.session(&machine, &session_id).cloned();
            let effects = stores.delete_controller.request_delete(
                &machine,
                &session_id,
                snapshot,
                label.as_deref(),
                ctx.now,
            );
            apply_delete_effects(stores, effects, &mut r);
        }
        Intent::UndoDelete => {
            let effects = stores.delete_controller.undo();
            apply_delete_effects(stores, effects, &mut r);
        }

        Intent::BeginPairing { url, label } => match parse_pairing_url(&url) {
            Ok(parts) => begin_pairing(stores, identity, PairingEvent::BeginPair { parts, label }, &mut r),
            Err(_) => stores.pairing.error = Some("invalid pairing URL".to_string()),
        },
        Intent::BeginManualPairing { npub, token, label } => match parse_manual_pair(&npub, &token) {
            Ok(parts) => begin_pairing(stores, identity, PairingEvent::BeginPair { parts, label }, &mut r),
            Err(_) => stores.pairing.error = Some("invalid npub or token".to_string()),
        },
        Intent::StagePairing { url } => match parse_pairing_url(&url) {
            Ok(parts) => begin_pairing(stores, identity, PairingEvent::StagePair(parts), &mut r),
            Err(_) => stores.pairing.error = Some("invalid pairing URL".to_string()),
        },
        Intent::ConfirmStagedPairing { label } => {
            begin_pairing(stores, identity, PairingEvent::ConfirmStaged { label }, &mut r)
        }
        Intent::DismissStagedPairing => {
            begin_pairing(stores, identity, PairingEvent::DismissStaged, &mut r)
        }
        Intent::ResetPairing => begin_pairing(stores, identity, PairingEvent::Reset, &mut r),
        Intent::RemoveMachine { pubkey_hex } => {
            let session_ids: Vec<String> = stores
                .machines
                .machine(&pubkey_hex)
                .map(|m| m.sessions.keys().cloned().collect())
                .unwrap_or_default();
            if stores.machines.remove_machine(&pubkey_hex) {
                r.persist(StoreId::Machines);
                r.resubscribe = true;
                for session_id in session_ids {
                    stores.ui.clear_session_unread(&pubkey_hex, &session_id);
                    // Drop the in-memory coverage bookkeeping too, not just
                    // the persisted rows below — otherwise a stale local_high
                    // would make `TranscriptRowsView::load` believe rows still
                    // exist right up until the next sync cycle re-derives it.
                    stores.transcript.remove_session(&pubkey_hex, &session_id);
                    r.transcript_removed.push((pubkey_hex.clone(), session_id));
                }
                r.ui_changed = true;
                if stores.ui.selected_machine.as_deref() == Some(pubkey_hex.as_str()) {
                    stores.ui.select_machine(None);
                }
            }
        }
        Intent::RespondPermission {
            machine,
            session_id,
            request_id,
            option_id,
        } => {
            // Optimistic: mark the card responded now (the durable proof is the
            // `resolved` entry that eventually lands).
            stores
                .ui
                .mark_card_responded(&machine, &session_id, &request_id);
            r.ui_changed = true;
            r.send(
                &machine,
                PhoneToBridge::PermissionResponse(PermissionResponseMsg {
                    version: v(),
                    session_id,
                    request_id,
                    option_id,
                }),
            );
        }
        Intent::AnswerQuestion {
            machine,
            session_id,
            request_id,
            index,
            answer,
        } => {
            // One responded key per question, so a multi-question card moves
            // to its next question before the bridge resolves the whole ask.
            stores
                .ui
                .mark_card_responded(&machine, &session_id, &question_card_key(&request_id, index));
            r.ui_changed = true;
            r.send(
                &machine,
                PhoneToBridge::QuestionResponse(QuestionResponseMsg {
                    version: v(),
                    session_id,
                    request_id,
                    index,
                    answer,
                }),
            );
        }
        Intent::RespondPlan {
            machine,
            session_id,
            request_id,
            option_id,
        } => {
            stores
                .ui
                .mark_card_responded(&machine, &session_id, &request_id);
            r.ui_changed = true;
            r.send(
                &machine,
                PhoneToBridge::PlanResponse(PlanResponseMsg {
                    version: v(),
                    session_id,
                    request_id,
                    option_id,
                }),
            );
        }
        Intent::SetOption {
            machine,
            session_id,
            option,
            value,
        } => r.send(
            &machine,
            PhoneToBridge::SetOption(SetOptionMsg {
                version: v(),
                session_id,
                option,
                value,
            }),
        ),
        Intent::Interrupt {
            machine,
            session_id,
        } => r.send(
            &machine,
            PhoneToBridge::Interrupt(SessionIdMsg {
                version: v(),
                session_id,
            }),
        ),
        Intent::CloseSession {
            machine,
            session_id,
        } => r.send(
            &machine,
            PhoneToBridge::CloseSession(SessionIdMsg {
                version: v(),
                session_id,
            }),
        ),
        Intent::CreateSession {
            machine,
            agent,
            cwd,
            create_cwd,
            mode,
            effort,
            model,
            provider_id,
            test_session,
        } => r.send(
            &machine,
            PhoneToBridge::CreateSession(CreateSessionMsg {
                version: v(),
                agent,
                mode,
                effort,
                model,
                test_session,
                cwd,
                create_cwd,
                provider_id,
            }),
        ),
        Intent::RefreshSessions { machine } => {
            r.send(&machine, PhoneToBridge::RefreshSessions(BareMsg { version: v() }))
        }
        Intent::RequestModels { machine, agent } => r.send(
            &machine,
            PhoneToBridge::ModelsRequest(ModelsRequestMsg {
                version: v(),
                agent,
            }),
        ),
        Intent::RequestUsage {
            machine,
            session_id,
        } => r.send(
            &machine,
            PhoneToBridge::UsageRequest(SessionIdMsg {
                version: v(),
                session_id,
            }),
        ),
        Intent::RequestGsd {
            machine,
            session_id,
        } => r.send(
            &machine,
            PhoneToBridge::GsdRequest(SessionIdMsg {
                version: v(),
                session_id,
            }),
        ),
        Intent::SetCredentials {
            machine,
            agent,
            values,
        } => {
            stores
                .ui
                .note_credentials_sent(&machine, agent.as_deref(), ctx.now);
            r.ui_changed = true;
            r.send(
                &machine,
                PhoneToBridge::SetCredentials(SetCredentialsMsg {
                    version: v(),
                    agent,
                    values,
                }),
            );
        }
        Intent::SetProviderProfile {
            machine,
            profile_id,
            profile,
        } => r.send(
            &machine,
            PhoneToBridge::SetProviderProfile(SetProviderProfileMsg {
                version: v(),
                profile_id,
                profile,
            }),
        ),
        Intent::RequestProviderProfiles { machine } => r.send(
            &machine,
            PhoneToBridge::ProviderProfilesRequest(BareMsg { version: v() }),
        ),
        Intent::SetDeviceConfig { machine, config } => r.send(
            &machine,
            PhoneToBridge::SetDeviceConfig(SetDeviceConfigMsg {
                version: v(),
                config,
            }),
        ),
        Intent::CreateFolder {
            machine,
            path,
            root,
            request_id,
        } => r.send(
            &machine,
            PhoneToBridge::CreateFolder(CreateFolderMsg {
                version: v(),
                path,
                root,
                request_id,
            }),
        ),

        // --- pure store ---
        Intent::SelectSession {
            machine,
            session_id,
        } => {
            r.ui_effects =
                stores
                    .ui
                    .select_session(&machine, session_id.as_deref(), ctx.visible);
            r.ui_changed = true;
        }
        Intent::SelectDmPeer { peer } => {
            r.ui_effects = stores.ui.select_dm_peer(peer.as_deref());
            stores.dm.set_active_peer(peer.as_deref());
            r.persist(StoreId::Dm);
            r.ui_changed = true;
        }
        Intent::MarkDmRead { peer } => {
            if stores.dm.mark_read(&peer) {
                r.persist(StoreId::Dm);
            }
        }
        Intent::StartDmConversation { peer_input } => {
            if let Some(sc) = stores.dm.start_conversation(&peer_input, ctx.now) {
                if sc.created {
                    r.persist(StoreId::Dm);
                }
            }
        }
        Intent::SendDm { peer, text } => {
            r.dm_send = Some((peer, text));
        }
        Intent::SendDmImage { peer, text, image } => {
            r.dm_image_send = Some((peer, text, image));
        }
        Intent::SelectMarmotGroup { group_id } => {
            stores.ui.select_marmot_group(group_id.as_deref());
            stores.marmot.set_active_group(group_id.as_deref());
            r.persist(StoreId::Marmot);
            r.ui_changed = true;
        }
        Intent::MarkMarmotRead { group_id } => {
            if stores.marmot.mark_read(&group_id) {
                r.persist(StoreId::Marmot);
            }
        }
        Intent::AcceptMarmotWelcome { welcome_id } => {
            r.marmot_accept = Some(welcome_id);
        }
        Intent::SendMarmotMessage { group_id, text } => {
            r.marmot_send = Some((group_id, text));
        }
        Intent::StartMarmotChat { peer_pubkey } => {
            r.marmot_start_chat = Some(peer_pubkey);
        }
        Intent::AddRelay { url } => apply_relay_effects(stores.settings.add_relay(&url), &mut r),
        Intent::RemoveRelay { url } => {
            apply_relay_effects(stores.settings.remove_relay(&url), &mut r)
        }
        Intent::AddRelays { urls } => apply_relay_effects(stores.settings.add_relays(&urls), &mut r),
        Intent::SetTorEnabled(on) => {
            stores.settings.set_tor_proxy_enabled(on);
            r.tor_changed = Some(on);
            r.persist(StoreId::Settings);
        }
        Intent::SetStayConnected(on) => {
            stores.settings.set_stay_connected(on);
            r.persist(StoreId::Settings);
        }
        Intent::SetMeshTestTarget(on) => {
            stores.settings.set_mesh_test_target(on);
            r.persist(StoreId::Settings);
        }
        Intent::SetBlossomServer(url) => {
            stores.settings.set_blossom_server(&url);
            r.persist(StoreId::Settings);
        }
        Intent::SetNotificationsEnabled(on) => {
            stores.settings.set_notifications_enabled(on);
            r.persist(StoreId::Settings);
        }
        Intent::SetDefaultMode(mode) => {
            stores.settings.set_default_mode(&mode);
            r.persist(StoreId::Settings);
        }
        Intent::SetDefaultEffort(level) => {
            stores.settings.set_default_effort(&level);
            r.persist(StoreId::Settings);
        }
        Intent::SetDefaultModel(model) => {
            stores.settings.set_default_model(&model);
            r.persist(StoreId::Settings);
        }
        Intent::SetUiScale(scale) => {
            stores.settings.set_ui_scale(scale);
            r.persist(StoreId::Settings);
        }
        Intent::SetShowUsageBadge(on) => {
            stores.settings.set_show_usage_badge(on);
            r.persist(StoreId::Settings);
        }
        Intent::SetShowCommitBadge(on) => {
            stores.settings.set_show_commit_badge(on);
            r.persist(StoreId::Settings);
        }
        Intent::AddQuickPrompt { id, label, text } => {
            if stores.quick_prompts.add_prompt(&id, &label, &text) {
                r.persist(StoreId::QuickPrompts);
            }
        }
        Intent::UpdateQuickPrompt { id, label, text } => {
            if stores.quick_prompts.update_prompt(&id, &label, &text) {
                r.persist(StoreId::QuickPrompts);
            }
        }
        Intent::RemoveQuickPrompt { id } => {
            if stores.quick_prompts.remove_prompt(&id) {
                r.persist(StoreId::QuickPrompts);
            }
        }
        Intent::DismissPendingSession { pending_id } => {
            if stores.pending_sessions.contains(&pending_id) {
                stores.pending_sessions.dismiss(&pending_id);
                r.pending_sessions_changed = true;
            }
        }
        Intent::SetPlanApprovalChoice { card_id, key } => {
            stores.ui.set_plan_approval_choice(&card_id, &key);
            r.ui_changed = true;
        }
    }
    r
}

fn apply_relay_effects(effects: Vec<SettingsEffect>, r: &mut IntentResult) {
    for effect in effects {
        match effect {
            SettingsEffect::RelaysChanged(relays) => {
                r.relays_changed = Some(relays);
                r.persist(StoreId::Settings);
                r.resubscribe = true;
            }
        }
    }
}

/// Run a pairing event through the reducer + [`apply_pairing_effects`], folding
/// the transport-affecting effects into the [`IntentResult`].
fn begin_pairing(
    stores: &mut CoreStores,
    identity: &protocol::crypto::Keypair,
    event: PairingEvent,
    r: &mut IntentResult,
) {
    let result = pairing_reducer(&stores.pairing, event, PAIR_ACK_TIMEOUT_MS);
    let out = apply_pairing_effects(stores, identity, result);
    r.sends.extend(out.sends);
    for id in out.persist {
        r.persist(id);
    }
    r.resubscribe |= out.resubscribe;
    if out.relays_changed.is_some() {
        r.relays_changed = out.relays_changed;
    }
    if out.pair_deadline.is_some() {
        r.pair_deadline = out.pair_deadline;
    }
    if out.mesh_join.is_some() {
        r.mesh_join = out.mesh_join;
    }
    if out.pairing_settled.is_some() {
        r.pairing_settled = out.pairing_settled;
    }
}

/// Interpret the delete-controller's effects: the store mutations happen here,
/// the undo timer and the `close-session` send are surfaced on the result.
fn apply_delete_effects(stores: &mut CoreStores, effects: Vec<DeleteEffect>, r: &mut IntentResult) {
    for effect in effects {
        match effect {
            DeleteEffect::DismissSession { session_id, now } => {
                stores.machines.dismiss_session(&session_id, now)
            }
            DeleteEffect::RemoveSession { machine, session_id } => {
                stores.machines.user_remove_session(&machine, &session_id);
                r.persist(StoreId::Machines);
            }
            DeleteEffect::ClearSessionUnread { machine, session_id } => {
                stores.ui.clear_session_unread(&machine, &session_id);
                r.ui_changed = true;
            }
            DeleteEffect::DeselectSession { machine, session_id } => {
                if stores.ui.selected_machine.as_deref() == Some(machine.as_str())
                    && stores.ui.selected_session.as_deref() == Some(session_id.as_str())
                {
                    stores.ui.select_machine(Some(&machine));
                    r.ui_changed = true;
                }
            }
            DeleteEffect::ArmUndoTimer { ms } => r.undo_timer = Some(UndoTimer::Arm { ms }),
            DeleteEffect::ClearUndoTimer => r.undo_timer = Some(UndoTimer::Clear),
            DeleteEffect::ShowUndoToast {
                machine,
                session_id,
                label,
            } => {
                stores.ui.set_undo_toast(Some(UndoToast {
                    machine,
                    session_id,
                    label,
                }));
                r.ui_changed = true;
            }
            DeleteEffect::HideUndoToast => {
                stores.ui.set_undo_toast(None);
                r.ui_changed = true;
            }
            DeleteEffect::SendCloseSession { machine, session_id } => r.sends.push(Send {
                machine,
                msg: PhoneToBridge::CloseSession(SessionIdMsg {
                    version: VersionFields::default(),
                    session_id,
                }),
            }),
            DeleteEffect::RestoreSnapshot { machine, snapshot } => {
                stores.machines.restore_session(&machine, *snapshot);
                r.persist(StoreId::Machines);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{MemoryKv, MemoryTranscriptStore};
    use crate::stores::{hydrate, StoresConfig};

    async fn stores() -> (CoreStores, protocol::crypto::Keypair) {
        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();
        let h = hydrate(&kv, &ts, &StoresConfig::default()).await;
        (h.stores, h.keypair)
    }

    fn ctx() -> IntentCtx {
        IntentCtx {
            now: 1_000,
            visible: true,
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
        s.machines.register_machine("m", "laptop", None, None);
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
    async fn delete_session_dismisses_removes_arms_the_undo_and_shows_a_toast() {
        use protocol::common::RemoteSessionInfo;
        let (mut s, kp) = stores().await;
        s.machines.register_machine("m", "laptop", None, None);
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
                context_window: None,
                context_percentage: None,
                committed: None,
                state: None,
                seq_high: None,
                provider_id: None,
                provider_label: None,
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
        s.machines.register_machine("m", "laptop", None, None);
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
                context_window: None,
                context_percentage: None,
                committed: None,
                state: None,
                seq_high: None,
                provider_id: None,
                provider_label: None,
            },
            0,
        );
        s.ui.select_machine(Some("m"));
        s.ui.mark_session_unread("m", "s1");

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
    }

    #[tokio::test]
    async fn remove_machine_leaves_the_selection_alone_when_a_different_machine_is_selected() {
        let (mut s, kp) = stores().await;
        s.machines.register_machine("m1", "laptop", None, None);
        s.machines.register_machine("m2", "desktop", None, None);
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
                label: "my phone".into(),
            },
            &kp,
            ctx(),
        );

        assert_eq!(
            s.pairing.candidate.as_ref().unwrap().pubkey_hex,
            peer.pubkey_hex
        );
        assert!(matches!(out.pair_deadline, Some(PairDeadline::Arm { .. })));
        assert!(out.resubscribe);
        assert!(matches!(
            out.sends.as_slice(),
            [Send { machine, msg: PhoneToBridge::PairRequest(m) }]
                if *machine == peer.pubkey_hex
                    && m.pubkey_hex == kp.pubkey_hex
                    && m.token == "tok"
        ));

        // an invalid npub sets the error, no candidate, no send
        let mut s2 = stores().await.0;
        let bad = apply(
            &mut s2,
            Intent::BeginManualPairing {
                npub: "npub1nope".into(),
                token: "t".into(),
                label: "x".into(),
            },
            &kp,
            ctx(),
        );
        assert!(s2.pairing.candidate.is_none());
        assert!(s2.pairing.error.is_some());
        assert_eq!(bad, IntentResult::default());
    }

    #[tokio::test]
    async fn begin_pairing_from_a_url_merges_its_relays_before_the_pair_request_send() {
        let (mut s, kp) = stores().await;
        let bridge = protocol::crypto::generate_keypair();
        assert!(
            !s.settings.data.relays.iter().any(|r| r == "wss://new-relay.example"),
            "test relay must not already be a default"
        );

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

        // The relay is merged into settings and signalled to the loop
        // (`interpret_intent` applies `relays_changed` before `out.sends`,
        // so the transport is already pointed at it once the pair-request
        // below is actually dispatched).
        assert!(s.settings.data.relays.iter().any(|r| r == "wss://new-relay.example"));
        assert!(out
            .relays_changed
            .as_ref()
            .is_some_and(|relays| relays.iter().any(|r| r == "wss://new-relay.example")));
        assert!(out.persist.contains(&StoreId::Settings));
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
    async fn set_device_config_sends_the_config_verbatim() {
        let (mut s, kp) = stores().await;
        let config = protocol::common::DeviceConfig {
            label: "phone-1".into(),
            role: Some(protocol::common::DeviceRole::TestTarget),
            serial: None,
            mesh_ip: Some("10.0.0.1".into()),
            mesh_pubkey: Some("abc".into()),
            app_under_test: protocol::common::AppUnderTest::Veil,
            custom_package: None,
            custom_build_cmd: None,
            project_dir: None,
        };
        let out = apply(
            &mut s,
            Intent::SetDeviceConfig { machine: "m".into(), config: config.clone() },
            &kp,
            ctx(),
        );
        assert!(matches!(
            out.sends.as_slice(),
            [Send { machine, msg: PhoneToBridge::SetDeviceConfig(m) }]
                if machine == "m" && m.config == config
        ));
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
    async fn add_relay_emits_a_relays_changed_effect_and_persists() {
        let (mut s, kp) = stores().await;
        let out = apply(
            &mut s, Intent::AddRelay { url: "wss://new.example".into() }, &kp, ctx());
        assert!(out.relays_changed.unwrap().iter().any(|r| r == "wss://new.example"));
        assert_eq!(out.persist, vec![StoreId::Settings]);
        assert!(out.resubscribe);
        // adding the same relay again is a no-op
        let out2 = apply(
            &mut s, Intent::AddRelay { url: "wss://new.example".into() }, &kp, ctx());
        assert_eq!(out2, IntentResult::default());
    }

    #[tokio::test]
    async fn add_relays_merges_a_batch_in_one_call() {
        let (mut s, kp) = stores().await;
        let out = apply(
            &mut s,
            Intent::AddRelays {
                urls: vec!["wss://a.example".into(), "wss://b.example".into()],
            },
            &kp,
            ctx(),
        );
        let relays = out.relays_changed.unwrap();
        assert!(relays.iter().any(|r| r == "wss://a.example"));
        assert!(relays.iter().any(|r| r == "wss://b.example"));
        assert_eq!(out.persist, vec![StoreId::Settings]);
    }

    #[tokio::test]
    async fn every_settings_intent_mutates_the_store_and_persists() {
        let (mut s, kp) = stores().await;

        let out = apply(&mut s, Intent::SetMeshTestTarget(true), &kp, ctx());
        assert!(s.settings.data.mesh_test_target);
        assert_eq!(out.persist, vec![StoreId::Settings]);

        apply(&mut s, Intent::SetBlossomServer("https://blossom.example".into()), &kp, ctx());
        assert_eq!(s.settings.data.blossom_server, "https://blossom.example");

        apply(&mut s, Intent::SetDefaultEffort("high".into()), &kp, ctx());
        assert_eq!(s.settings.data.default_effort, "high");
        // empty string is the valid "unset" sentinel — not coerced to a default
        apply(&mut s, Intent::SetDefaultEffort(String::new()), &kp, ctx());
        assert_eq!(s.settings.data.default_effort, "");

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
}
