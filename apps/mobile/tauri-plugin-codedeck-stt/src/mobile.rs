use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::SpeechResponse;

pub struct CodedeckStt<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> CodedeckStt<R> {
    pub fn recognize_speech(&self) -> Result<SpeechResponse, String> {
        self.0
            .run_mobile_plugin::<SpeechResponse>("recognizeSpeech", ())
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>(
    _app: &AppHandle<R>,
    api: PluginApi<R, ()>,
) -> Result<CodedeckStt<R>, Box<dyn std::error::Error>> {
    let handle = api.register_android_plugin("com.codedeck.stt", "SttPlugin")?;
    Ok(CodedeckStt(handle))
}
