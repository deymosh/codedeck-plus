use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{EnableRequest, EnableResponse};

pub struct TorProxy<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> TorProxy<R> {
    pub fn enable(&self, request: EnableRequest) -> Result<EnableResponse, String> {
        self.0
            .run_mobile_plugin::<EnableResponse>("enable", request)
            .map_err(|e| e.to_string())
    }

    pub fn disable(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("disable", ())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>(
    _app: &AppHandle<R>,
    api: PluginApi<R, ()>,
) -> Result<TorProxy<R>, Box<dyn std::error::Error>> {
    let handle = api.register_android_plugin("com.codedeck.torproxy", "TorProxyPlugin")?;
    Ok(TorProxy(handle))
}
