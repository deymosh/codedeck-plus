use tauri::{AppHandle, Runtime};

use crate::models::{MeshActionResponse, MeshStatusResponse, PrepareAdbResponse};

/// Desktop no-op. The laptop joins the mesh via the standalone `nvpn` CLI/daemon, not via this
/// in-app VpnService (which only exists for the phones, per the "one app on the phone" goal).
pub struct Mesh<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Mesh<R> {
    pub fn join_mesh(&self) -> Result<MeshStatusResponse, String> {
        Ok(MeshStatusResponse { running: false, state_json: String::new() })
    }

    pub fn leave_mesh(&self) -> Result<MeshStatusResponse, String> {
        Ok(MeshStatusResponse { running: false, state_json: String::new() })
    }

    pub fn mesh_status(&self) -> Result<MeshStatusResponse, String> {
        Ok(MeshStatusResponse { running: false, state_json: String::new() })
    }

    pub fn mesh_action(&self, _action_json: String) -> Result<MeshActionResponse, String> {
        Ok(MeshActionResponse { state_json: String::new() })
    }

    pub fn open_wireless_debugging(&self) -> Result<(), String> {
        Ok(())
    }

    pub fn prepare_adb(&self) -> Result<PrepareAdbResponse, String> {
        Ok(PrepareAdbResponse { enabled: false })
    }
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<Mesh<R>, Box<dyn std::error::Error>> {
    Ok(Mesh(app.clone()))
}
