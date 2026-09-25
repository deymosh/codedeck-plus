//! Commands from phones: ingest, then one handler per message type.

use agent_protocol::{BridgeMessage, SelectOutcome};
use protocol::commands::{
    CreateFolderMsg, CreateSessionMsg, InputMsg, PermissionResponseMsg, PhoneToBridge, PlanResponseMsg,
    QuestionAnswer, QuestionResponseMsg, SetOptionMsg, UploadImageMsg,
};
use protocol::common::{is_valid_provider_base_url, SessionOption, PROVIDER_BASE_URL_ERROR};
use protocol::events::{
    BridgeToPhone, CloseSessionAckMsg, DeviceConfigAckMsg, FolderAckMsg, InputAckMsg, InputFailedMsg,
    InputFailedReason, ModelsMsg, SessionFailedMsg, SessionPendingMsg,
};

use super::{Engine, HostCall};
use crate::catalog::{is_effort, is_mode};
use crate::io::{Effect, InboundEvent, Via};
use crate::registry::{project_of, SessionRecord};
use crate::session::{option_answer, permission_summary, CardKind, Phase, Runner, Session, StartKind};

/// The wire name of a command, for logs. (Commands can carry secrets, so
/// they are never logged whole.)
fn type_name(msg: &PhoneToBridge) -> &'static str {
    match msg {
        PhoneToBridge::Input(_) => "input",
        PhoneToBridge::PermissionResponse(_) => "permission-response",
        PhoneToBridge::QuestionResponse(_) => "question-response",
        PhoneToBridge::PlanResponse(_) => "plan-response",
        PhoneToBridge::SetOption(_) => "set-option",
        PhoneToBridge::SyncRequest(_) => "sync-request",
        PhoneToBridge::SyncAck(_) => "sync-ack",
        PhoneToBridge::CreateSession(_) => "create-session",
        PhoneToBridge::RefreshSessions(_) => "refresh-sessions",
        PhoneToBridge::CloseSession(_) => "close-session",
        PhoneToBridge::Interrupt(_) => "interrupt",
        PhoneToBridge::CreateFolder(_) => "create-folder",
        PhoneToBridge::UploadImage(_) => "upload-image",
        PhoneToBridge::UsageRequest(_) => "usage-request",
        PhoneToBridge::GsdRequest(_) => "gsd-request",
        PhoneToBridge::ModelsRequest(_) => "models-request",
        PhoneToBridge::SetCredentials(_) => "set-credentials",
        PhoneToBridge::SetDeviceConfig(_) => "set-device-config",
        PhoneToBridge::PairRequest(_) => "pair-request",
        PhoneToBridge::SetProviderProfile(_) => "set-provider-profile",
        PhoneToBridge::ProviderProfilesRequest(_) => "provider-profiles-request",
    }
}

fn short(pubkey: &str) -> &str {
    pubkey.get(..8).unwrap_or(pubkey)
}

impl Engine {
    pub(super) fn on_relay_event(&mut self, event: &InboundEvent, via: Via) {
        let now_secs = self.now() / 1000;
        match via {
            Via::Pairing => {
                if let Some(req) = self.ingest.accept_pairing(event, &self.config.keys, now_secs) {
                    self.on_pair_request(req, &event.pubkey);
                }
            }
            Via::Commands => {
                let paired = &self.paired;
                let msg = self.ingest.accept(event, &self.config.keys, now_secs, |pk| paired.iter().any(|p| p.pubkey_hex == pk));
                if let Some(msg) = msg {
                    log::info!("[Engine] Received {} from {}...", type_name(&msg), short(&event.pubkey));
                    self.dispatch(msg, &event.pubkey);
                }
            }
        }
    }

    fn dispatch(&mut self, msg: PhoneToBridge, phone: &str) {
        match msg {
            PhoneToBridge::Input(m) => self.on_input(m),
            PhoneToBridge::PermissionResponse(m) => self.on_permission_response(m),
            PhoneToBridge::QuestionResponse(m) => self.on_question_response(m),
            PhoneToBridge::PlanResponse(m) => self.on_plan_response(m),
            PhoneToBridge::SetOption(m) => self.on_set_option(m),
            PhoneToBridge::SyncRequest(m) => {
                let sync_id = self.system.new_id();
                let seq_high = self.seq_highs.get(&m.session_id).copied().unwrap_or(0);
                self.sync.request(
                    &mut self.out,
                    self.transcripts.as_ref(),
                    sync_id,
                    &m.session_id,
                    phone,
                    &m.have_ranges,
                    seq_high,
                );
            }
            PhoneToBridge::SyncAck(m) => self.sync.ack(&mut self.out, &m.sync_id, m.range),
            PhoneToBridge::CreateSession(m) => self.on_create_session(m),
            PhoneToBridge::RefreshSessions(_) => self.list_dirty = true,
            PhoneToBridge::CloseSession(m) => self.on_close_session(&m.session_id),
            PhoneToBridge::Interrupt(m) => self.interrupt(&m.session_id),
            PhoneToBridge::CreateFolder(m) => self.on_create_folder(m),
            PhoneToBridge::UploadImage(m) => self.on_upload_image(m),
            PhoneToBridge::UsageRequest(m) => self.on_usage_request(&m.session_id),
            PhoneToBridge::GsdRequest(m) => {
                // Always answered, `available: false` included, so the phone
                // can retire a stale strip when a session leaves a GSD project.
                if let Some(session) = self.sessions.get(&m.session_id) {
                    let cwd = session.rec.cwd.clone();
                    self.out.push(Effect::ReadGsd { session_id: m.session_id, cwd });
                }
            }
            PhoneToBridge::ModelsRequest(m) => self.on_models_request(m.agent),
            PhoneToBridge::SetCredentials(m) => self.on_set_credentials(m, phone),
            PhoneToBridge::SetDeviceConfig(m) => {
                self.out.push(Effect::ApplyDeviceConfig { phone: phone.to_string(), config: m.config });
            }
            PhoneToBridge::PairRequest(m) => self.on_pair_request(m, phone),
            PhoneToBridge::SetProviderProfile(m) => self.on_set_provider_profile(m, phone),
            PhoneToBridge::ProviderProfilesRequest(_) => {
                let msg = self.provider_profiles_msg();
                self.publish_to(phone, msg);
            }
        }
    }

    fn on_input(&mut self, m: InputMsg) {
        let known = self.sessions.contains_key(&m.session_id);
        if self.send_input(&m.session_id, m.text) {
            if let Some(input_id) = m.input_id {
                self.publish_all(BridgeToPhone::InputAck(InputAckMsg { session_id: m.session_id, input_id }));
            }
            return;
        }
        log::info!("[Engine] No live session for input to {}", m.session_id);
        self.publish_all(BridgeToPhone::InputFailed(InputFailedMsg {
            session_id: m.session_id,
            // `no-session`: never heard of it; `error`: known, but not running.
            reason: if known { InputFailedReason::Error } else { InputFailedReason::NoSession },
            input_id: m.input_id,
        }));
    }

    fn on_permission_response(&mut self, m: PermissionResponseMsg) {
        let card = self.run_ref(&m.session_id).and_then(|r| r.cards.get(&m.request_id));
        let option = match card.map(|c| &c.kind) {
            Some(CardKind::Permission { options }) => options.iter().find(|o| o.id == m.option_id).cloned(),
            _ => {
                log::info!("[Engine] permission-response for {} in {} matched nothing pending", m.request_id, m.session_id);
                return;
            }
        };
        let Some(option) = option else {
            log::info!("[Engine] Option '{}' is not offered for {}", m.option_id, m.request_id);
            return;
        };
        let answer = BridgeMessage::PermissionOutcome(SelectOutcome::Selected { option_id: option.id });
        self.close_card(&m.session_id, &m.request_id, answer, permission_summary(option.kind));
    }

    fn on_plan_response(&mut self, m: PlanResponseMsg) {
        let card = self.run_ref(&m.session_id).and_then(|r| r.cards.get(&m.request_id));
        let option = match card.map(|c| &c.kind) {
            Some(CardKind::Plan { options }) => options.iter().find(|o| o.id == m.option_id).cloned(),
            _ => {
                log::info!("[Engine] plan-response for {} in {} matched nothing pending", m.request_id, m.session_id);
                return;
            }
        };
        let Some(option) = option else {
            log::info!("[Engine] Plan option '{}' is not offered for {}", m.option_id, m.request_id);
            return;
        };
        // An approving option's mode change comes back from the agent as
        // session info.
        let answer = BridgeMessage::PlanOutcome(SelectOutcome::Selected { option_id: option.id });
        self.close_card(&m.session_id, &m.request_id, answer, &option.label);
    }

    fn on_question_response(&mut self, m: QuestionResponseMsg) {
        let card = self.run_ref(&m.session_id).and_then(|r| r.cards.get(&m.request_id));
        let answer = match (card.map(|c| &c.kind), m.answer) {
            (Some(CardKind::Question { .. }), QuestionAnswer::Text { text }) => Some(text),
            (Some(CardKind::Question { questions, .. }), QuestionAnswer::Options { selected }) => {
                questions.get(m.index as usize).and_then(|q| option_answer(q, &selected))
            }
            _ => None,
        };
        let answered = answer.is_some_and(|a| self.answer_question(&m.session_id, &m.request_id, m.index, a));
        if !answered {
            log::info!(
                "[Engine] question-response for {}#{} in {} matched nothing pending",
                m.request_id,
                m.index,
                m.session_id
            );
        }
    }

    /// Change a session's mode, effort or model. The value must be one its
    /// agent advertises; a refused change publishes nothing, so the phone
    /// keeps showing what it knew.
    fn on_set_option(&mut self, m: SetOptionMsg) {
        let Some(session) = self.sessions.get(&m.session_id) else { return };
        if !session.run.as_ref().is_some_and(|r| r.started) {
            log::info!("[Engine] set-option for {}, which is not running", m.session_id);
            return;
        }
        let Some(agent) = self.catalog.get(&session.rec.agent) else { return };
        let refused = match m.option {
            SessionOption::Mode => (!is_mode(agent, &m.value)).then(|| format!("not a {} mode", agent.id)),
            SessionOption::Effort => (!is_effort(agent, &m.value)).then(|| format!("not a {} effort level", agent.id)),
            // A session bound to a provider profile may only use that
            // profile's models: any other id would be sent to the provider.
            SessionOption::Model => session.rec.provider_id.as_ref().and_then(|pid| match self.profiles.get(pid) {
                None => Some(format!("provider profile '{pid}' was deleted")),
                Some(p) if !p.models.iter().any(|x| x.id == m.value) => Some(format!("not a model of provider profile '{pid}'")),
                Some(_) => None,
            }),
        };
        if let Some(why) = refused {
            log::info!("[Engine] {:?} '{}' refused for {}: {why}", m.option, m.value, m.session_id);
            return;
        }
        self.call(
            HostCall::SetOption { session_id: m.session_id.clone(), option: m.option, value: m.value.clone() },
            BridgeMessage::SetOption { session_id: m.session_id, option: m.option, value: m.value },
        );
    }

    /// A session from the phone: `session-pending` at once, then
    /// `session-ready` or `session-failed` — never a session that silently
    /// never appears.
    fn on_create_session(&mut self, m: CreateSessionMsg) {
        let session_id = self.system.new_id();
        let create_cwd = m.create_cwd == Some(true);
        let cwd = self.workspace.resolve_cwd(m.cwd.as_deref(), create_cwd);
        if create_cwd {
            self.list_dirty = true;
        }
        log::info!(
            "[Engine] Create {} session {session_id} in {cwd} (model {:?}, mode {:?}, effort {:?}, provider {:?})",
            m.agent,
            m.model,
            m.mode,
            m.effort,
            m.provider_id
        );
        let now = self.now_iso();
        self.publish_all(BridgeToPhone::SessionPending(SessionPendingMsg {
            pending_id: session_id.clone(),
            machine: self.config.machine.clone(),
            created_at: now.clone(),
        }));

        let agent = match self.catalog.usable(&m.agent) {
            Ok(agent) => agent.clone(),
            Err(reason) => return self.refuse_session(&session_id, reason),
        };
        let profile = m.provider_id.as_ref().map(|id| (id, self.profiles.get(id)));
        if let Some((id, profile)) = profile {
            // Checked here too, not only at start, so the phone gets the plain
            // reason on the card it is looking at.
            let refusal = if !agent.supports.providers {
                Some(format!(
                    "{} does not support custom provider profiles — it always uses its own configured providers.",
                    agent.display_name
                ))
            } else {
                match profile {
                    None => Some(format!("Unknown provider profile '{id}' — it may have been deleted on this machine.")),
                    Some(p) if !is_valid_provider_base_url(&p.base_url) => Some(format!(
                        "Provider profile '{}' has an insecure base URL ({}) — {PROVIDER_BASE_URL_ERROR}. Its API token would travel in cleartext. Edit the profile in Settings and save it again.",
                        p.label, p.base_url
                    )),
                    Some(p) if p.auth_token.is_none() => {
                        Some(format!("Provider profile '{}' has no API token stored — set one in Settings first.", p.label))
                    }
                    Some(_) => None,
                }
            };
            if let Some(reason) = refusal {
                return self.refuse_session(&session_id, reason);
            }
        }
        // A provider-bound session defaults to the profile's model: the
        // agent's own default is not one the provider serves.
        let model = m.model.clone().or_else(|| {
            m.provider_id.as_ref().and_then(|id| self.profiles.get(id)).and_then(|p| p.fallback_model()).map(str::to_string)
        });
        // An unknown mode or effort falls back to the agent's default rather
        // than failing the session.
        let mode = m.mode.filter(|x| {
            let known = is_mode(&agent, x);
            if !known {
                log::info!("[Engine] Create session {session_id}: ignoring unknown mode '{x}'");
            }
            known
        });
        let effort = m.effort.filter(|x| {
            let known = is_effort(&agent, x);
            if !known {
                log::info!("[Engine] Create session {session_id}: ignoring unknown effort '{x}'");
            }
            known
        });
        let test_session = m.test_session == Some(true);
        let rec = SessionRecord {
            session_id: session_id.clone(),
            agent: agent.id.clone(),
            project: project_of(&cwd),
            cwd,
            native_session_id: None,
            previous_native_session_id: None,
            model,
            provider_id: m.provider_id,
            effort,
            mode: mode.or_else(|| agent.default_mode.clone()),
            title: None,
            created_at: now.clone(),
            last_activity: now,
            committed: false,
            context_window: None,
            context_percentage: None,
            test_session,
        };
        let run = Runner::new(Phase::Pending, StartKind::Create, false);
        self.sessions.insert(session_id.clone(), Session { rec, listed: false, run: Some(run) });
        self.spawn(&session_id);
    }

    fn refuse_session(&mut self, session_id: &str, reason: String) {
        log::info!("[Engine] Create session {session_id} refused: {reason}");
        self.publish_all(BridgeToPhone::SessionFailed(SessionFailedMsg { pending_id: session_id.to_string(), reason }));
    }

    fn on_close_session(&mut self, session_id: &str) {
        let existed = self.sessions.contains_key(session_id);
        self.close_runner(session_id, "Session closed");
        self.sessions.remove(session_id);
        self.tombstones.add(session_id);
        self.registry_dirty = true;
        if let Err(err) = self.transcripts.remove(session_id) {
            log::warn!("[Engine] Removing the transcript of {session_id} failed: {err}");
        }
        self.seq_highs.remove(session_id);
        self.publish_all(BridgeToPhone::CloseSessionAck(CloseSessionAckMsg {
            session_id: session_id.to_string(),
            success: existed,
        }));
        self.list_dirty = true;
    }

    fn on_create_folder(&mut self, m: CreateFolderMsg) {
        let result = self.workspace.create_folder(m.root.as_deref(), &m.path);
        let (success, path, error) = match result {
            Ok(path) => {
                self.list_dirty = true;
                (true, Some(path), None)
            }
            Err(err) => {
                log::info!("[Engine] create-folder '{}' refused: {err}", m.path);
                (false, None, Some(err))
            }
        };
        self.publish_all(BridgeToPhone::FolderAck(FolderAckMsg { request_id: m.request_id, success, path, error }));
    }

    fn on_upload_image(&mut self, m: UploadImageMsg) {
        let session_id = match &m {
            UploadImageMsg::Blossom(b) => &b.session_id,
            UploadImageMsg::Chunk(c) => &c.session_id,
        };
        if self.run_ref(session_id).is_none() {
            log::info!("[Engine] Image for {session_id}, which is not running — dropped");
            return;
        }
        self.out.push(Effect::HandleImageUpload(m));
    }

    fn on_usage_request(&mut self, session_id: &str) {
        let Some(session) = self.sessions.get(session_id) else { return };
        if !self.is_running(session_id) {
            return;
        }
        // Subscription usage is priced and windowed for the agent's own
        // provider; for a custom provider those numbers would be wrong, so
        // nothing is sent.
        if session.rec.provider_id.is_some() {
            log::info!("[Engine] usage-request for provider-bound session {session_id} withheld");
            return;
        }
        if !self.catalog.get(&session.rec.agent).is_some_and(|a| a.supports.usage) {
            return;
        }
        self.call(
            HostCall::GetUsage { session_id: session_id.to_string() },
            BridgeMessage::GetUsage { session_id: session_id.to_string() },
        );
    }

    fn on_models_request(&mut self, agent: String) {
        let error = match self.catalog.usable(&agent) {
            Err(reason) => Some(reason),
            Ok(_) => {
                let sent = self.call(HostCall::ListModels { agent: agent.clone() }, BridgeMessage::ListModels { agent: agent.clone() });
                sent.is_none().then(|| "The agent host is not running — try again in a moment.".to_string())
            }
        };
        if let Some(error) = error {
            log::info!("[Engine] models-request: {error}");
            self.publish_all(BridgeToPhone::Models(ModelsMsg { agent, models: vec![], default_model: None, error: Some(error) }));
        }
    }

    pub(super) fn on_device_config_applied(&mut self, phone: &str, result: Result<(), String>) {
        let error = result.err();
        if let Some(err) = &error {
            log::warn!("[Engine] Device config for {}... failed: {err}", short(phone));
        }
        self.publish_to(phone, BridgeToPhone::DeviceConfigAck(DeviceConfigAckMsg { success: error.is_none(), reachable: None, error }));
    }
}
