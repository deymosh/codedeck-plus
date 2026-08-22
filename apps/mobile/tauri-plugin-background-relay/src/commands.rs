use tauri::{ipc::Channel, AppHandle, Runtime};

use crate::models::{ConnectivitySnapshot, ConnectivityUpdate, ServiceStatusResponse, UpdateStateRequest};
use crate::BackgroundRelayExt;

#[tauri::command]
pub async fn start_service<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.background_relay().start_service()
}

#[tauri::command]
pub async fn stop_service<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.background_relay().stop_service()
}

#[tauri::command]
pub async fn is_running<R: Runtime>(app: AppHandle<R>) -> Result<ServiceStatusResponse, String> {
    app.background_relay().is_running()
}

#[tauri::command]
pub async fn update_state<R: Runtime>(app: AppHandle<R>, text: String) -> Result<(), String> {
    app.background_relay().update_state(UpdateStateRequest { text })
}

#[tauri::command]
pub async fn get_connectivity<R: Runtime>(
    app: AppHandle<R>,
) -> Result<ConnectivitySnapshot, String> {
    app.background_relay().get_connectivity()
}

#[tauri::command]
pub async fn watch_connectivity<R: Runtime>(
    app: AppHandle<R>,
    channel: Channel<ConnectivityUpdate>,
) -> Result<(), String> {
    app.background_relay().watch_connectivity(channel)
}

#[tauri::command]
pub async fn unwatch_connectivity<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.background_relay().unwatch_connectivity()
}
