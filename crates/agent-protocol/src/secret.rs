use std::fmt;

use serde::{Deserialize, Serialize};

/// A credential value (API key, token) crossing the bridge/host pipe.
///
/// Serializes as a plain string — the pipe is a local process boundary, and
/// the host needs the value to hand it to the agent — but its `Debug` output
/// is redacted, so a message containing one can be logged with `{:?}`
/// without leaking the secret.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The secret itself. Every call site is a place the value leaves this
    /// type's protection, so keep them few.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_shows_the_value_but_the_wire_does() {
        let s = Secret::new("sk-ant-very-secret");
        assert!(!format!("{s:?}").contains("very-secret"));
        assert_eq!(serde_json::to_string(&s).unwrap(), r#""sk-ant-very-secret""#);
        assert_eq!(serde_json::from_str::<Secret>(r#""x""#).unwrap().expose(), "x");
    }
}
