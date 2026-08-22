use serde::Serialize;
use tauri::{
    ipc::Channel,
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{
    ConnectivitySnapshot, ConnectivityUpdate, ServiceStatusResponse, UpdateStateRequest,
};

/// Payload for the Kotlin `watchConnectivity` command — the channel
/// serializes as `__CHANNEL__:{id}` and Kotlin's `parseArgs` rebuilds it.
#[derive(Serialize)]
struct WatchConnectivityArgs {
    channel: Channel<ConnectivityUpdate>,
}

pub struct BackgroundRelay<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> BackgroundRelay<R> {
    pub fn start_service(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("startService", ())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn stop_service(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("stopService", ())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn is_running(&self) -> Result<ServiceStatusResponse, String> {
        self.0
            .run_mobile_plugin::<ServiceStatusResponse>("isRunning", ())
            .map_err(|e| e.to_string())
    }

    pub fn update_state(&self, request: UpdateStateRequest) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("updateState", request)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn get_connectivity(&self) -> Result<ConnectivitySnapshot, String> {
        self.0
            .run_mobile_plugin::<ConnectivitySnapshot>("getConnectivity", ())
            .map_err(|e| e.to_string())
    }

    pub fn watch_connectivity(&self, channel: Channel<ConnectivityUpdate>) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>(
                "watchConnectivity",
                WatchConnectivityArgs { channel },
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn unwatch_connectivity(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("unwatchConnectivity", ())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>(
    _app: &AppHandle<R>,
    api: PluginApi<R, ()>,
) -> Result<BackgroundRelay<R>, Box<dyn std::error::Error>> {
    let handle =
        api.register_android_plugin("com.codedeck.backgroundrelay", "BackgroundRelayPlugin")?;
    Ok(BackgroundRelay(handle))
}
