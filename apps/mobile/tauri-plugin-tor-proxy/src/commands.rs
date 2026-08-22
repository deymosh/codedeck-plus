use tauri::{AppHandle, Runtime};

use crate::models::{EnableRequest, EnableResponse};
use crate::TorProxyExt;

#[tauri::command]
pub async fn enable<R: Runtime>(
    app: AppHandle<R>,
    request: EnableRequest,
) -> Result<EnableResponse, String> {
    app.tor_proxy().enable(request)
}

#[tauri::command]
pub async fn disable<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.tor_proxy().disable()
}
