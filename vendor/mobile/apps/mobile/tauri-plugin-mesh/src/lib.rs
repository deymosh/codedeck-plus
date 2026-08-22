//! tauri-plugin-mesh — embeds the nostr-vpn FIPS mesh as CodeDeck's own Android VpnService.
//!
//! Phone-side only: lets CodeDeck join the mesh (so the office laptop can reach a test phone over
//! the encrypted overlay) without a separate VPN app. Desktop builds are a no-op — the laptop uses
//! the standalone `nvpn` CLI. Structural clone of `tauri-plugin-background-relay`.

mod commands;
mod models;

#[cfg(mobile)]
mod mobile;

#[cfg(not(mobile))]
mod desktop;

pub use models::*;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(mobile)]
type MeshImpl<R> = mobile::Mesh<R>;

#[cfg(not(mobile))]
type MeshImpl<R> = desktop::Mesh<R>;

pub trait MeshExt<R: Runtime> {
    fn mesh(&self) -> &MeshImpl<R>;
}

impl<R: Runtime, T: Manager<R>> MeshExt<R> for T {
    fn mesh(&self) -> &MeshImpl<R> {
        self.state::<MeshImpl<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mesh")
        .invoke_handler(tauri::generate_handler![
            commands::join_mesh,
            commands::leave_mesh,
            commands::mesh_status,
            commands::mesh_action,
            commands::open_wireless_debugging,
            commands::prepare_adb,
        ])
        .setup(|app, _api| {
            #[cfg(mobile)]
            {
                let m = mobile::init(app, _api)?;
                app.manage(m);
            }
            #[cfg(not(mobile))]
            {
                let m = desktop::init(app)?;
                app.manage(m);
            }
            Ok(())
        })
        .build()
}
