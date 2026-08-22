use tauri::{AppHandle, Runtime};

use crate::models::{MeshActionResponse, MeshStatusResponse, PrepareAdbResponse};
use crate::MeshExt;

#[tauri::command]
pub async fn join_mesh<R: Runtime>(app: AppHandle<R>) -> Result<MeshStatusResponse, String> {
    app.mesh().join_mesh()
}

#[tauri::command]
pub async fn leave_mesh<R: Runtime>(app: AppHandle<R>) -> Result<MeshStatusResponse, String> {
    app.mesh().leave_mesh()
}

#[tauri::command]
pub async fn mesh_status<R: Runtime>(app: AppHandle<R>) -> Result<MeshStatusResponse, String> {
    app.mesh().mesh_status()
}

#[tauri::command]
pub async fn mesh_action<R: Runtime>(
    app: AppHandle<R>,
    action_json: String,
) -> Result<MeshActionResponse, String> {
    app.mesh().mesh_action(action_json)
}

/// Open Android's Wireless Debugging settings screen so the user can enable it (one tap).
/// Needed so the laptop can `adb connect` to this device over the mesh.
#[tauri::command]
pub async fn open_wireless_debugging<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.mesh().open_wireless_debugging()
}

/// Enable Wireless Debugging (no user tap — we hold WRITE_SECURE_SETTINGS) and report the current
/// adbd-wifi listener port, so the Bridge can recover an adb-over-mesh connection after WD turns off
/// or its port rotates.
#[tauri::command]
pub async fn prepare_adb<R: Runtime>(app: AppHandle<R>) -> Result<PrepareAdbResponse, String> {
    app.mesh().prepare_adb()
}
