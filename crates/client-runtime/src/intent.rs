//! Intent — the closed set of user actions (migration plan §2.2). `apply`
//! folds one into the `CoreStores` and returns an [`IntentResult`]: commands to
//! sign+publish, stores to persist, and the transport-affecting effects
//! (`resubscribe`, a new relay list, a Tor toggle).
//!
//! This slice covers the session-interaction commands and the pure store
//! actions. `SendInput`, `RetryOutboxItem`, `DeleteSession` / `UndoDelete`,
//! `BeginPairing` and `UploadImage` need the outbox lifecycle / timers /
//! transport and land with the loop integration.

use client_core::stores::outbox::OutboxState;
use client_core::stores::settings::SettingsEffect;
use client_core::stores::ui::UiEffect;
use client_core::wire::commands::{
    BareMsg, CreateSessionMsg, EffortChangeMsg, InputMsg, KeypressContext, KeypressMsg,
    ModeChangeMsg, ModelChangeMsg, PermissionModifier, PermissionResMsg, PhoneToBridge,
    QuestionInputMsg, SessionIdMsg, VersionFields,
};
use client_core::wire::common::{EffortLevel, PermissionMode};

use crate::dispatch::{Send, StoreId};
use crate::stores::CoreStores;

/// A send whose publish outcome must settle an outbox item.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboxSend {
    pub id: String,
    pub machine: String,
    pub msg: PhoneToBridge,
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
#[derive(Debug, Clone, PartialEq)]
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

    // --- session commands ---
    RespondPermission {
        machine: String,
        session_id: String,
        request_id: String,
        allow: bool,
        modifier: Option<PermissionModifier>,
    },
    AnswerQuestion {
        machine: String,
        session_id: String,
        text: String,
        option_count: u64,
    },
    Keypress {
        machine: String,
        session_id: String,
        key: String,
        context: Option<KeypressContext>,
    },
    SetMode {
        machine: String,
        session_id: String,
        mode: PermissionMode,
    },
    SetEffort {
        machine: String,
        session_id: String,
        level: EffortLevel,
    },
    SetModel {
        machine: String,
        session_id: String,
        model: String,
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
        cwd: Option<String>,
        create_cwd: Option<bool>,
        model: Option<String>,
        default_effort: Option<EffortLevel>,
        provider_id: Option<String>,
        test_session: Option<bool>,
    },
    RefreshSessions {
        machine: String,
    },
    RequestModels {
        machine: String,
    },
    RequestUsage {
        machine: String,
        session_id: String,
    },
    RequestGsd {
        machine: String,
        session_id: String,
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
    AddRelay {
        url: String,
    },
    RemoveRelay {
        url: String,
    },
    SetTorEnabled(bool),
    SetStayConnected(bool),
    SetNotificationsEnabled(bool),
    SetDefaultMode(PermissionMode),
    SetDefaultModel(String),
    SetUiScale(f64),
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
}

pub fn apply(stores: &mut CoreStores, intent: Intent, ctx: IntentCtx) -> IntentResult {
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
            if let Some(item) = stores.outbox.mark_retry(&id) {
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
        Intent::RespondPermission {
            machine,
            session_id,
            request_id,
            allow,
            modifier,
        } => {
            // Optimistic: mark the card responded now (the durable proof is the
            // tool_result that eventually lands).
            stores
                .ui
                .mark_card_responded(&machine, &session_id, &request_id);
            r.send(
                &machine,
                PhoneToBridge::PermissionRes(PermissionResMsg {
                    version: v(),
                    session_id,
                    request_id,
                    allow,
                    modifier,
                }),
            );
        }
        Intent::AnswerQuestion {
            machine,
            session_id,
            text,
            option_count,
        } => r.send(
            &machine,
            PhoneToBridge::QuestionInput(QuestionInputMsg {
                version: v(),
                session_id,
                text,
                option_count,
            }),
        ),
        Intent::Keypress {
            machine,
            session_id,
            key,
            context,
        } => r.send(
            &machine,
            PhoneToBridge::Keypress(KeypressMsg {
                version: v(),
                session_id,
                key,
                context,
            }),
        ),
        Intent::SetMode {
            machine,
            session_id,
            mode,
        } => r.send(
            &machine,
            PhoneToBridge::Mode(ModeChangeMsg {
                version: v(),
                session_id,
                mode,
            }),
        ),
        Intent::SetEffort {
            machine,
            session_id,
            level,
        } => r.send(
            &machine,
            PhoneToBridge::Effort(EffortChangeMsg {
                version: v(),
                session_id,
                level,
            }),
        ),
        Intent::SetModel {
            machine,
            session_id,
            model,
        } => r.send(
            &machine,
            PhoneToBridge::Model(ModelChangeMsg {
                version: v(),
                session_id,
                model,
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
            cwd,
            create_cwd,
            model,
            default_effort,
            provider_id,
            test_session,
        } => r.send(
            &machine,
            PhoneToBridge::CreateSession(CreateSessionMsg {
                version: v(),
                default_effort,
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
        Intent::RequestModels { machine } => {
            r.send(&machine, PhoneToBridge::ModelsRequest(BareMsg { version: v() }))
        }
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

        // --- pure store ---
        Intent::SelectSession {
            machine,
            session_id,
        } => {
            r.ui_effects =
                stores
                    .ui
                    .select_session(&machine, session_id.as_deref(), ctx.visible);
        }
        Intent::SelectDmPeer { peer } => {
            r.ui_effects = stores.ui.select_dm_peer(peer.as_deref());
        }
        Intent::MarkDmRead { peer } => {
            if stores.dm.mark_read(&peer) {
                r.persist(StoreId::Dm);
            }
        }
        Intent::AddRelay { url } => apply_relay_effects(stores.settings.add_relay(&url), &mut r),
        Intent::RemoveRelay { url } => {
            apply_relay_effects(stores.settings.remove_relay(&url), &mut r)
        }
        Intent::SetTorEnabled(on) => {
            stores.settings.set_tor_proxy_enabled(on);
            r.tor_changed = Some(on);
            r.persist(StoreId::Settings);
        }
        Intent::SetStayConnected(on) => {
            stores.settings.set_stay_connected(on);
            r.persist(StoreId::Settings);
        }
        Intent::SetNotificationsEnabled(on) => {
            stores.settings.set_notifications_enabled(on);
            r.persist(StoreId::Settings);
        }
        Intent::SetDefaultMode(mode) => {
            stores.settings.set_default_mode(mode);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{MemoryKv, MemoryTranscriptStore};
    use crate::stores::{hydrate, StoresConfig};

    async fn stores() -> CoreStores {
        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();
        hydrate(&kv, &ts, &StoresConfig::default()).await.stores
    }

    fn ctx() -> IntentCtx {
        IntentCtx {
            now: 1_000,
            visible: true,
        }
    }

    #[tokio::test]
    async fn send_input_queues_an_outbox_item_clears_unread_and_stamps_a_stopgap_title() {
        use client_core::stores::outbox::OutboxItemState;
        let mut s = stores().await;
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
        let mut s = stores().await;
        let item = OutboxState::new_input("in-1", "m", "s1", "hi", 100);
        s.outbox.begin_publish(item);
        // still Pending → retry is a no-op
        assert_eq!(
            apply(&mut s, Intent::RetryOutboxItem { machine: "m".into(), id: "in-1".into() }, ctx()),
            IntentResult::default()
        );
        // fail it, then retry re-queues
        s.outbox.fail("in-1", "boom", 200);
        let out = apply(
            &mut s,
            Intent::RetryOutboxItem { machine: "m".into(), id: "in-1".into() },
            ctx(),
        );
        assert!(out.outbox_send.is_some());
        assert_eq!(s.outbox.items["in-1"].attempts, 2);
    }

    #[tokio::test]
    async fn respond_permission_marks_the_card_and_sends() {
        let mut s = stores().await;
        let out = apply(
            &mut s,
            Intent::RespondPermission {
                machine: "m".into(),
                session_id: "s1".into(),
                request_id: "req-1".into(),
                allow: true,
                modifier: None,
            },
            ctx(),
        );
        assert!(s.ui.is_card_responded("m", "s1", "req-1"));
        assert!(matches!(
            out.sends.as_slice(),
            [Send { machine, msg: PhoneToBridge::PermissionRes(m) }]
                if machine == "m" && m.allow && m.request_id == "req-1"
        ));
    }

    #[tokio::test]
    async fn set_mode_maps_to_one_command() {
        let mut s = stores().await;
        let out = apply(
            &mut s,
            Intent::SetMode {
                machine: "m".into(),
                session_id: "s1".into(),
                mode: PermissionMode::AcceptEdits,
            },
            ctx(),
        );
        assert!(matches!(
            out.sends.as_slice(),
            [Send { msg: PhoneToBridge::Mode(m), .. }]
                if m.mode == PermissionMode::AcceptEdits
        ));
        assert!(out.persist.is_empty()); // the CONFIRM writes state, not the request
    }

    #[tokio::test]
    async fn add_relay_emits_a_relays_changed_effect_and_persists() {
        let mut s = stores().await;
        let out = apply(&mut s, Intent::AddRelay { url: "wss://new.example".into() }, ctx());
        assert!(out.relays_changed.unwrap().iter().any(|r| r == "wss://new.example"));
        assert_eq!(out.persist, vec![StoreId::Settings]);
        assert!(out.resubscribe);
        // adding the same relay again is a no-op
        let out2 = apply(&mut s, Intent::AddRelay { url: "wss://new.example".into() }, ctx());
        assert_eq!(out2, IntentResult::default());
    }

    #[tokio::test]
    async fn select_session_returns_the_cdx_026c_effect_and_moves_the_ui() {
        let mut s = stores().await;
        s.ui.mark_session_unread("m", "s1");
        let out = apply(
            &mut s,
            Intent::SelectSession {
                machine: "m".into(),
                session_id: Some("s1".into()),
            },
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
        let mut s = stores().await;
        let add = apply(
            &mut s,
            Intent::AddQuickPrompt {
                id: "qp-1".into(),
                label: "Go".into(),
                text: "continue".into(),
            },
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
            ctx(),
        );
        assert!(rej.persist.is_empty());
        // unknown id remove → no persist
        let miss = apply(&mut s, Intent::RemoveQuickPrompt { id: "nope".into() }, ctx());
        assert!(miss.persist.is_empty());
    }
}
