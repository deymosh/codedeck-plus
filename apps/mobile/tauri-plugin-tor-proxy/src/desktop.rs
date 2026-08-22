use tauri::{AppHandle, Runtime};

use crate::models::{EnableRequest, EnableResponse};

pub struct TorProxy<R: Runtime>(AppHandle<R>);

impl<R: Runtime> TorProxy<R> {
    /// Desktop: no-op. Orbot is Android-only — a desktop Tauri build has no
    /// equivalent proxy to route through here (a system-level SOCKS proxy on
    /// desktop is a user/OS networking concern, not something this plugin
    /// manages).
    pub fn enable(&self, _request: EnableRequest) -> Result<EnableResponse, String> {
        Ok(EnableResponse { supported: false })
    }

    pub fn disable(&self) -> Result<(), String> {
        Ok(())
    }
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<TorProxy<R>, Box<dyn std::error::Error>> {
    Ok(TorProxy(app.clone()))
}
