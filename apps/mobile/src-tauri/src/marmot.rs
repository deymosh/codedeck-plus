//! Marmot (MLS) DMs — the `#[tauri::command]` layer. The MDK 0.8 / MLS +
//! SQLCipher engine lives in `client_core::marmot_engine` (feature `marmot`,
//! shared with the future composed Core); this file is the thin Tauri wrapper:
//! one `MarmotService` behind a std `Mutex`, initialised by `marmot_init`, the
//! lock never held across an await (async gift-wrap / unwrap clone the `Keys`
//! out first).

use std::path::PathBuf;
use std::sync::Mutex;

use nostr::prelude::*;

use client_core::marmot_engine::{
    gift_wrap_welcome, unwrap_welcome, GroupCreated, GroupInfo, Ingested, MarmotService, Outgoing,
    WelcomeInfo,
};

// --- Tauri command layer ---
//
// One service behind a std Mutex, initialized by `marmot_init`. The lock is
// NEVER held across an await: async steps (gift wrap / unwrap) clone the Keys
// out first, sync MDK work happens under short lock scopes.

#[derive(Default)]
pub struct MarmotState(Mutex<Option<MarmotService>>);

impl MarmotState {
    fn with<T>(
        &self,
        f: impl FnOnce(&MarmotService) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self.0.lock().map_err(|_| "marmot lock poisoned".to_string())?;
        let svc = guard
            .as_ref()
            .ok_or_else(|| "marmot not initialized".to_string())?;
        f(svc)
    }

    fn keys(&self) -> Result<Keys, String> {
        self.with(|svc| Ok(svc.keys().clone()))
    }
}

/// Initialize (idempotent): open the MDK store in the app data dir with a key
/// derived from the identity secret. Returns our pubkey hex. The secret is
/// never logged; re-init with the SAME identity is a no-op, a DIFFERENT
/// identity is refused (one store per app data dir).
#[tauri::command]
pub async fn marmot_init(
    app: tauri::AppHandle,
    state: tauri::State<'_, MarmotState>,
    secret_hex: String,
) -> Result<String, String> {
    use tauri::Manager;
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    let db_path = dir.join("marmot.db");

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "marmot lock poisoned".to_string())?;
    if let Some(existing) = guard.as_ref() {
        let requested = Keys::parse(&secret_hex)
            .map_err(|_| "invalid identity secret".to_string())?;
        if requested.public_key() != existing.keys().public_key() {
            return Err("marmot already initialized with a different identity".into());
        }
        return Ok(existing.pubkey_hex());
    }
    let svc = MarmotService::open(&db_path, &secret_hex)?;
    let pubkey = svc.pubkey_hex();
    *guard = Some(svc);
    Ok(pubkey)
}

/// A fresh signed kind-30443 KeyPackage event (JSON) for JS to publish.
#[tauri::command]
pub async fn marmot_publish_key_package(
    state: tauri::State<'_, MarmotState>,
    relays: Vec<String>,
) -> Result<String, String> {
    state.with(|svc| Ok(svc.key_package_event(&relays)?.as_json()))
}

/// Create a 1:1 group with `peer` from their kind-30443 event JSON. Returns
/// the group ids + the gift-wrapped welcome (kind-1059 JSON) to publish.
#[tauri::command]
pub async fn marmot_create_group(
    state: tauri::State<'_, MarmotState>,
    peer_pubkey: String,
    peer_key_package_json: String,
    relays: Vec<String>,
) -> Result<GroupCreated, String> {
    let peer = PublicKey::from_hex(&peer_pubkey).map_err(|e| format!("parse peer pubkey: {e}"))?;
    let kp_event = Event::from_json(&peer_key_package_json)
        .map_err(|e| format!("parse key package event: {e}"))?;
    let (info, rumor) = state.with(|svc| svc.create_group(&peer, kp_event, &relays))?;
    let keys = state.keys()?;
    let wrapped = gift_wrap_welcome(&keys, &peer, rumor).await?;
    Ok(GroupCreated {
        group_id: info.group_id,
        h_tag: info.h_tag,
        welcome_event_json: wrapped.as_json(),
    })
}

/// Encrypt a chat message for a group → kind-445 JSON to publish + rumor id.
#[tauri::command]
pub async fn marmot_send(
    state: tauri::State<'_, MarmotState>,
    group_id: String,
    text: String,
) -> Result<Outgoing, String> {
    state.with(|svc| svc.send(&group_id, &text))
}

/// Feed one received relay event (kind 1059 or 445) into MDK. Never throws on
/// foreign/undecryptable events — returns `ignored` so the JS side counts it.
#[tauri::command]
pub async fn marmot_ingest(
    state: tauri::State<'_, MarmotState>,
    event_json: String,
) -> Result<Ingested, String> {
    let event = Event::from_json(&event_json).map_err(|e| format!("parse event: {e}"))?;
    if event.kind == Kind::GiftWrap {
        let keys = state.keys()?;
        let (wrapper_id, rumor) = match unwrap_welcome(&keys, &event).await {
            Ok(pair) => pair,
            Err(reason) => return Ok(Ingested::Ignored { reason }),
        };
        return match state.with(|svc| svc.process_welcome(&wrapper_id, &rumor)) {
            Ok(info) => Ok(Ingested::Welcome {
                welcome_id: info.welcome_id,
                wrapper_id: info.wrapper_id,
                group_id: info.group_id,
                h_tag: info.h_tag,
                name: info.name,
                welcomer: info.welcomer,
                member_count: info.member_count,
            }),
            // A dead/duplicate/foreign welcome is a drop, not an app error.
            Err(reason) => Ok(Ingested::Ignored { reason }),
        };
    }
    if event.kind == Kind::MlsGroupMessage {
        return state.with(|svc| svc.ingest_group_message(&event));
    }
    Ok(Ingested::Ignored {
        reason: format!("kind {} is not a Marmot event", event.kind.as_u16()),
    })
}

#[tauri::command]
pub async fn marmot_pending_welcomes(
    state: tauri::State<'_, MarmotState>,
) -> Result<Vec<WelcomeInfo>, String> {
    state.with(|svc| svc.pending_welcomes())
}

#[tauri::command]
pub async fn marmot_accept_welcome(
    state: tauri::State<'_, MarmotState>,
    welcome_id: String,
) -> Result<GroupInfo, String> {
    state.with(|svc| svc.accept_welcome(&welcome_id))
}

#[tauri::command]
pub async fn marmot_list_groups(
    state: tauri::State<'_, MarmotState>,
) -> Result<Vec<GroupInfo>, String> {
    state.with(|svc| svc.list_groups())
}
