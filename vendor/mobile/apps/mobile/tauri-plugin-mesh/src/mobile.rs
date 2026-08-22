use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{MeshActionResponse, MeshStatusResponse, PrepareAdbResponse};

/// Handle to the Android `MeshPlugin` (Kotlin). All real work — JNI into
/// `libnostr_vpn_app_core`, VpnService lifecycle — lives there; this is the typed bridge.
pub struct Mesh<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Mesh<R> {
    pub fn join_mesh(&self) -> Result<MeshStatusResponse, String> {
        self.0
            .run_mobile_plugin::<MeshStatusResponse>("joinMesh", ())
            .map_err(|e| e.to_string())
    }

    pub fn leave_mesh(&self) -> Result<MeshStatusResponse, String> {
        self.0
            .run_mobile_plugin::<MeshStatusResponse>("leaveMesh", ())
            .map_err(|e| e.to_string())
    }

    pub fn mesh_status(&self) -> Result<MeshStatusResponse, String> {
        self.0
            .run_mobile_plugin::<MeshStatusResponse>("meshStatus", ())
            .map_err(|e| e.to_string())
    }

    pub fn mesh_action(&self, action_json: String) -> Result<MeshActionResponse, String> {
        self.0
            .run_mobile_plugin::<MeshActionResponse>(
                "meshAction",
                serde_json::json!({ "actionJson": action_json }),
            )
            .map_err(|e| e.to_string())
    }

    pub fn open_wireless_debugging(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("openWirelessDebugging", ())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn prepare_adb(&self) -> Result<PrepareAdbResponse, String> {
        self.0
            .run_mobile_plugin::<PrepareAdbResponse>("prepareAdb", ())
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>(
    _app: &AppHandle<R>,
    api: PluginApi<R, ()>,
) -> Result<Mesh<R>, Box<dyn std::error::Error>> {
    let handle = api.register_android_plugin("com.codedeck.mesh", "MeshPlugin")?;
    Ok(Mesh(handle))
}
