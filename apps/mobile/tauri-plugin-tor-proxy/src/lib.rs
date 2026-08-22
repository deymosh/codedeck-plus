//! Routes the WebView's own outbound traffic — including the relay
//! WebSockets `platform/relayTransport.ts` opens — through Orbot's SOCKS5
//! proxy, via `androidx.webkit.ProxyController.setProxyOverride()`.
//!
//! Why this can't be done in TypeScript: unlike Node's `ws` package (which
//! the bridge uses, with a `socks-proxy-agent`), a browser/WebView
//! `WebSocket` has no per-connection proxy/agent option. The WebView's own
//! network stack has to be told to route through SOCKS5, once, for the whole
//! WebView — which is a native Android API, not a JS one. See
//! `StayConnectedService.kt`'s own header comment for confirmation that the
//! WebView (not this Rust/Kotlin layer) is what owns the relay sockets.
//!
//! `setProxyOverride` affects only NEW connections made after it's called —
//! JS must call `enable` before opening its first relay WebSocket (see
//! `main.tsx`, which loads the persisted "route through Orbot" setting and
//! enables this before constructing the relay transport).

mod commands;
mod models;

#[cfg(mobile)]
mod mobile;

#[cfg(not(mobile))]
mod desktop;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(mobile)]
type TorProxyImpl<R> = mobile::TorProxy<R>;

#[cfg(not(mobile))]
type TorProxyImpl<R> = desktop::TorProxy<R>;

pub trait TorProxyExt<R: Runtime> {
    fn tor_proxy(&self) -> &TorProxyImpl<R>;
}

impl<R: Runtime, T: Manager<R>> TorProxyExt<R> for T {
    fn tor_proxy(&self) -> &TorProxyImpl<R> {
        self.state::<TorProxyImpl<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("tor-proxy")
        .invoke_handler(tauri::generate_handler![commands::enable, commands::disable])
        .setup(|app, _api| {
            #[cfg(mobile)]
            {
                let tp = mobile::init(app, _api)?;
                app.manage(tp);
            }
            #[cfg(not(mobile))]
            {
                let tp = desktop::init(app)?;
                app.manage(tp);
            }
            Ok(())
        })
        .build()
}
