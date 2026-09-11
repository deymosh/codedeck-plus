//! `Tristate<T>` — the wire's absent / null / value distinction, used where the
//! TS schema is `z.string().nullable().optional()` with a keep/clear/set
//! meaning (`set-credentials`, `set-provider-profile.authToken`).
//!
//! - field absent  → `Keep`  (leave the stored value alone)
//! - field `null`  → `Clear` (delete the stored value)
//! - field value   → `Set(v)`
//!
//! On a struct field use `#[serde(default, skip_serializing_if = "Tristate::is_keep")]`.

use serde::de::{Deserialize, Deserializer};
use serde::ser::{Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Tristate<T> {
    #[default]
    Keep,
    Clear,
    Set(T),
}

impl<T> Tristate<T> {
    pub fn is_keep(&self) -> bool {
        matches!(self, Tristate::Keep)
    }
}

impl<T: Serialize> Serialize for Tristate<T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            // Keep is skipped by `skip_serializing_if`; if it ever reaches here,
            // emit it as null (harmless — the field is optional on the other end).
            Tristate::Keep | Tristate::Clear => s.serialize_none(),
            Tristate::Set(v) => v.serialize(s),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Tristate<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // The field is only handed to us when PRESENT (serde skips absent
        // fields → `#[serde(default)]` gives `Keep`). Present-and-null → `Clear`.
        match Option::<T>::deserialize(d)? {
            Some(v) => Ok(Tristate::Set(v)),
            None => Ok(Tristate::Clear),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Msg {
        #[serde(default, skip_serializing_if = "Tristate::is_keep")]
        token: Tristate<String>,
    }

    #[test]
    fn absent_is_keep_and_round_trips_to_absent() {
        let m: Msg = serde_json::from_str("{}").unwrap();
        assert_eq!(m.token, Tristate::Keep);
        assert_eq!(serde_json::to_string(&m).unwrap(), "{}");
    }

    #[test]
    fn null_is_clear_and_round_trips_to_null() {
        let m: Msg = serde_json::from_str(r#"{"token":null}"#).unwrap();
        assert_eq!(m.token, Tristate::Clear);
        assert_eq!(serde_json::to_string(&m).unwrap(), r#"{"token":null}"#);
    }

    #[test]
    fn value_is_set_and_round_trips_to_value() {
        let m: Msg = serde_json::from_str(r#"{"token":"sk-abc"}"#).unwrap();
        assert_eq!(m.token, Tristate::Set("sk-abc".to_string()));
        assert_eq!(serde_json::to_string(&m).unwrap(), r#"{"token":"sk-abc"}"#);
    }
}
