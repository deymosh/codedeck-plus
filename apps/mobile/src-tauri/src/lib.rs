//! CodeDeck mobile shell — deliberately minimal Rust.
//!
//! The webview phone core owns all app logic; this crate hosts the plugins
//! (SQLite persistence, codedeck:// deep links, OS notifications, the two 5c
//! local plugins: mic STT + the stay-connected foreground service, and the 5d
//! mesh plugin: the embedded nostr-vpn VpnService — all no-ops on desktop)
//! plus, since Phase 6 (CDX-012), the Marmot/MLS module: MDK does the crypto
//! here in Rust, JS keeps owning transport (events as JSON over `marmot_*`
//! commands). Desktop gets Marmot for free — same code.

#[cfg(feature = "native-core")]
pub mod corebridge;
#[cfg(feature = "native-core")]
pub mod native_ports;
pub mod marmot;
pub mod sqlstore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(marmot::MarmotState::default())
        // CDX-012: tauri-plugin-sql is gone — its sqlx pins libsqlite3-sys
        // 0.28 while MDK's rusqlite needs 0.35, and cargo forbids two linked
        // sqlite3 copies. sqlstore serves the same SqlExecutor seam (same DB
        // file/path) over the one rusqlite build; see sqlstore.rs.
        .manage(sqlstore::SqlState::default())
        .invoke_handler(tauri::generate_handler![
            marmot::marmot_init,
            marmot::marmot_publish_key_package,
            marmot::marmot_create_group,
            marmot::marmot_send,
            marmot::marmot_ingest,
            marmot::marmot_pending_welcomes,
            marmot::marmot_accept_welcome,
            marmot::marmot_list_groups,
            sqlstore::sql_open,
            sqlstore::sql_execute,
            sqlstore::sql_select,
            #[cfg(feature = "native-core")]
            corebridge::core_available,
            #[cfg(feature = "native-core")]
            corebridge::core_init,
            #[cfg(feature = "native-core")]
            corebridge::core_start,
            #[cfg(feature = "native-core")]
            corebridge::core_stop,
            #[cfg(feature = "native-core")]
            corebridge::core_pause,
            #[cfg(feature = "native-core")]
            corebridge::core_resume,
            #[cfg(feature = "native-core")]
            corebridge::core_set_online,
            #[cfg(feature = "native-core")]
            corebridge::core_set_machines,
            #[cfg(feature = "native-core")]
            corebridge::core_set_relays,
            #[cfg(feature = "native-core")]
            corebridge::core_send,
            #[cfg(feature = "native-core")]
            corebridge::core_publish,
            #[cfg(feature = "native-core")]
            corebridge::core_connection_status,
            #[cfg(feature = "native-core")]
            corebridge::core_dispatch,
            #[cfg(feature = "native-core")]
            corebridge::core_machines_view,
            #[cfg(feature = "native-core")]
            corebridge::core_settings_view,
            #[cfg(feature = "native-core")]
            corebridge::core_outbox_view,
            #[cfg(feature = "native-core")]
            corebridge::core_pairing_view,
            #[cfg(feature = "native-core")]
            corebridge::core_dm_view,
            #[cfg(feature = "native-core")]
            corebridge::core_marmot_view,
        ])
        .plugin(tauri_plugin_deep_link::init())
        // CDX-029: Rust-side fetch escape hatch — Blossom's upload preflight
        // carries no CORS headers, so the WebView cannot PUT; plugin-http can.
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_codedeck_stt::init())
        .plugin(tauri_plugin_background_relay::init())
        .plugin(tauri_plugin_tor_proxy::init())
        .plugin(tauri_plugin_mesh::init());
    // F1: the in-process Rust client-runtime handle (behind the `native-core`
    // feature). Inert until the WebView calls `core_init`.
    #[cfg(feature = "native-core")]
    let builder = builder.manage(corebridge::CoreBridge::default());
    // CDX-011: QR camera scan for pairing — the plugin exists on mobile only
    // (desktop pairing pastes the URL / uses the codedeck:// deep link).
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .run(tauri::generate_context!())
        .expect("error while running CodeDeck");
}
