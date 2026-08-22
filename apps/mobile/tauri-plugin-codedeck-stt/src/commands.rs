use tauri::{AppHandle, Runtime};

use crate::CodedeckSttExt;
use crate::SpeechResponse;

#[tauri::command]
pub async fn recognize_speech<R: Runtime>(app: AppHandle<R>) -> Result<SpeechResponse, String> {
    app.codedeck_stt().recognize_speech()
}
