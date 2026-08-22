use tauri::{AppHandle, Runtime};

use crate::SpeechResponse;

pub struct CodedeckStt<R: Runtime>(AppHandle<R>);

impl<R: Runtime> CodedeckStt<R> {
    /// Desktop has no system recognizer intent — resolve null; the JS side
    /// focuses the text input instead (plan §5).
    pub fn recognize_speech(&self) -> Result<SpeechResponse, String> {
        Ok(SpeechResponse { text: None })
    }
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<CodedeckStt<R>, Box<dyn std::error::Error>> {
    Ok(CodedeckStt(app.clone()))
}
