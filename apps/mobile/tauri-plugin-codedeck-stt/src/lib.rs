//! CodeDeck STT plugin (Phase 5c, plan §5 "mic button").
//!
//! Android: fires `RecognizerIntent.ACTION_RECOGNIZE_SPEECH` — the SYSTEM
//! recognizer UI — via an activity result and returns the recognized text.
//! The system recognizer holds RECORD_AUDIO itself; this app declares no mic
//! permission. Desktop: `recognize_speech` resolves `{ text: null }` and the
//! JS side focuses the input instead.

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
type CodedeckSttImpl<R> = mobile::CodedeckStt<R>;

#[cfg(not(mobile))]
type CodedeckSttImpl<R> = desktop::CodedeckStt<R>;

pub trait CodedeckSttExt<R: Runtime> {
    fn codedeck_stt(&self) -> &CodedeckSttImpl<R>;
}

impl<R: Runtime, T: Manager<R>> CodedeckSttExt<R> for T {
    fn codedeck_stt(&self) -> &CodedeckSttImpl<R> {
        self.state::<CodedeckSttImpl<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("codedeck-stt")
        .invoke_handler(tauri::generate_handler![commands::recognize_speech])
        .setup(|app, _api| {
            #[cfg(mobile)]
            {
                let stt = mobile::init(app, _api)?;
                app.manage(stt);
            }
            #[cfg(not(mobile))]
            {
                let stt = desktop::init(app)?;
                app.manage(stt);
            }
            Ok(())
        })
        .build()
}
