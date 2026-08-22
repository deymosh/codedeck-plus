use tauri::{ipc::Channel, AppHandle, Runtime};

use crate::models::{
    ConnectivitySnapshot, ConnectivityUpdate, ServiceStatusResponse, UpdateStateRequest,
};

pub struct BackgroundRelay<R: Runtime>(AppHandle<R>);

impl<R: Runtime> BackgroundRelay<R> {
    /// Desktop: the whole feature is compiled to no-ops — desktop WebSockets
    /// survive backgrounding fine and there is no doze to fight.
    pub fn start_service(&self) -> Result<(), String> {
        Ok(())
    }

    pub fn stop_service(&self) -> Result<(), String> {
        Ok(())
    }

    pub fn is_running(&self) -> Result<ServiceStatusResponse, String> {
        Ok(ServiceStatusResponse { running: false })
    }

    pub fn update_state(&self, _request: UpdateStateRequest) -> Result<(), String> {
        Ok(())
    }

    /// Desktop has no ConnectivityManager — `supported: false` tells JS to
    /// keep its `navigator.onLine` fallback (which works fine there).
    pub fn get_connectivity(&self) -> Result<ConnectivitySnapshot, String> {
        Ok(ConnectivitySnapshot {
            supported: false,
            online: true,
        })
    }

    pub fn watch_connectivity(&self, _channel: Channel<ConnectivityUpdate>) -> Result<(), String> {
        Ok(())
    }

    pub fn unwatch_connectivity(&self) -> Result<(), String> {
        Ok(())
    }
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<BackgroundRelay<R>, Box<dyn std::error::Error>> {
    Ok(BackgroundRelay(app.clone()))
}
