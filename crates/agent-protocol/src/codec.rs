//! JSON-lines framing. One frame per line, UTF-8, no embedded newlines
//! (serde_json escapes them). Decoding is total: every input yields a frame
//! or a [`FrameError`], never a panic.

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::messages::{BridgeFrame, BridgeMessage, Frame, HostFrame, HostMessage};

/// Version of the driver protocol. Carried in every frame as `v`; a peer
/// refuses frames of any other version. Bump it on a breaking change — both
/// ends ship together, so there is no negotiation.
pub const DRIVER_PROTOCOL_VERSION: u32 = 1;

/// Longest accepted line. Drivers truncate large tool output long before
/// this; a line past it is a bug or a runaway, and is refused unparsed.
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("frame of {0} bytes exceeds the {MAX_LINE_BYTES}-byte limit")]
    TooLong(usize),
    #[error("driver protocol v{0} is not supported (expected v{DRIVER_PROTOCOL_VERSION})")]
    Version(u32),
    #[error("malformed frame: {0}")]
    Malformed(String),
}

fn decode<M: DeserializeOwned>(line: &str) -> Result<Frame<M>, FrameError> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.len() > MAX_LINE_BYTES {
        return Err(FrameError::TooLong(line.len()));
    }
    // The version is checked before the body, so a frame from a newer peer
    // reports the mismatch instead of whatever its unknown kind fails on.
    #[derive(serde::Deserialize)]
    struct VersionOnly {
        v: u32,
    }
    let version: VersionOnly =
        serde_json::from_str(line).map_err(|e| FrameError::Malformed(e.to_string()))?;
    if version.v != DRIVER_PROTOCOL_VERSION {
        return Err(FrameError::Version(version.v));
    }
    serde_json::from_str(line).map_err(|e| FrameError::Malformed(e.to_string()))
}

pub fn decode_bridge_frame(line: &str) -> Result<BridgeFrame, FrameError> {
    decode(line)
}

pub fn decode_host_frame(line: &str) -> Result<HostFrame, FrameError> {
    decode(line)
}

/// A frame as one line, without the trailing newline.
pub fn encode_frame<M: Serialize>(frame: &Frame<M>) -> String {
    // Serialization of these types cannot fail: every map key is a string
    // and no type has a fallible custom serializer.
    serde_json::to_string(frame).expect("driver frames always serialize")
}

impl<M> Frame<M> {
    pub fn request(id: impl Into<String>, message: M) -> Self {
        Self { v: DRIVER_PROTOCOL_VERSION, id: Some(id.into()), message }
    }

    pub fn notification(message: M) -> Self {
        Self { v: DRIVER_PROTOCOL_VERSION, id: None, message }
    }
}

impl BridgeMessage {
    /// Whether this message answers a host request (as opposed to asking).
    pub fn is_reply(&self) -> bool {
        matches!(
            self,
            Self::PermissionOutcome(_)
                | Self::PlanOutcome(_)
                | Self::QuestionOutcome(_)
                | Self::HostToolResult { .. }
        )
    }
}

impl HostMessage {
    /// Whether this message answers a bridge request (as opposed to asking
    /// or notifying).
    pub fn is_reply(&self) -> bool {
        matches!(
            self,
            Self::Initialized { .. }
                | Self::Ack
                | Self::Error { .. }
                | Self::Models { .. }
                | Self::Usage { .. }
                | Self::CredentialChecked { .. }
        )
    }
}
