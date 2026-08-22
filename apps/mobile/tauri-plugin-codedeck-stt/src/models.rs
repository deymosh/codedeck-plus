use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeechResponse {
    /// Recognized text, or None when cancelled / unavailable / desktop.
    pub text: Option<String>,
}
