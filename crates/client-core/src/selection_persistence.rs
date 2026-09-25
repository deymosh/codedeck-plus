//! CDX-054 — the selected session survives an activity recreation / WebView
//! reload. Port of the pure half of `apps/mobile/src/core/selectionPersistence.ts`.
//!
//! The last selection is persisted through the KV port and restored on boot,
//! but ONLY within a short TTL so a genuine cold start (hours later) still opens
//! on the drawer home surface. The runtime owns the KV read/write and refreshes
//! the timestamp on every selection change AND on every app-hide signal (an
//! activity recreation passes through onPause before the process dies).

use serde::{Deserialize, Serialize};

pub const LAST_SELECTION_KEY: &str = "client.lastSelection";

/// Recreation completes in seconds; a minute of slack covers slow devices
/// without turning cold starts into session restores.
pub const SELECTION_RESTORE_TTL_MS: u64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSelection {
    pub machine: String,
    pub session_id: String,
    /// ms timestamp of the last selection change or app-hide refresh.
    pub at: u64,
}

pub fn encode_selection(sel: &PersistedSelection) -> String {
    serde_json::to_string(sel).expect("PersistedSelection serializes")
}

/// Tolerant decode: bad JSON, a non-object, a missing/empty `machine` or
/// `session_id`, or a non-finite / non-integer `at` all yield `None`.
pub fn decode_selection(raw: Option<&str>) -> Option<PersistedSelection> {
    let raw = raw?;
    let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let obj = value.as_object()?;

    let machine = obj.get("machine")?.as_str()?;
    let session_id = obj.get("sessionId")?.as_str()?;
    if machine.is_empty() || session_id.is_empty() {
        return None;
    }
    // `at` must be a finite, non-negative integer. serde_json's `as_u64`
    // rejects fractional and negative numbers and non-number types.
    let at = obj.get("at")?.as_u64()?;

    Some(PersistedSelection {
        machine: machine.to_string(),
        session_id: session_id.to_string(),
        at,
    })
}

/// Fresh enough to be a reload, not a cold start.
///
/// The window is bounded on BOTH sides. Android boots with the RTC ahead and
/// NTP corrects it seconds later, so `now` can legitimately move backwards
/// across a reload; a record stamped in the future is not fresh, it is
/// untrustworthy — no restore, the drawer home wins. (`u64` subtraction makes a
/// backward clock wrap huge, which is `> TTL` and so correctly not restorable;
/// the explicit `now >= at` guard keeps that intent legible.)
pub fn is_restorable(sel: Option<&PersistedSelection>, now: u64) -> bool {
    match sel {
        Some(sel) => now >= sel.at && now - sel.at <= SELECTION_RESTORE_TTL_MS,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sel(machine: &str, session_id: &str, at: u64) -> PersistedSelection {
        PersistedSelection {
            machine: machine.to_string(),
            session_id: session_id.to_string(),
            at,
        }
    }

    #[test]
    fn round_trips_and_garbage_or_partial_records_decode_to_none() {
        let s = sel("m1", "s1", 42);
        assert_eq!(decode_selection(Some(&encode_selection(&s))), Some(s));
        assert_eq!(decode_selection(None), None);
        assert_eq!(decode_selection(Some("not json")), None);
        assert_eq!(decode_selection(Some(r#"{"machine":"m1"}"#)), None);
        assert_eq!(
            decode_selection(Some(r#"{"machine":"","sessionId":"s","at":1}"#)),
            None
        );
        assert_eq!(
            decode_selection(Some(r#"{"machine":"m","sessionId":"s","at":"soon"}"#)),
            None
        );
    }

    #[test]
    fn is_restorable_is_fresh_within_the_ttl_and_stale_beyond_it() {
        let s = sel("m", "s", 1_000);
        assert!(is_restorable(Some(&s), 1_000 + SELECTION_RESTORE_TTL_MS));
        assert!(!is_restorable(Some(&s), 1_000 + SELECTION_RESTORE_TTL_MS + 1));
        assert!(!is_restorable(None, 0));
    }

    #[test]
    fn a_record_stamped_in_the_future_is_not_restorable() {
        // A backward clock correction (record `at` ahead of `now`) must not read
        // as fresh forever — the 60 s invariant only held forwards pre-fix.
        let at = 10_000_000_000; // epoch-ms scale, so "six hours earlier" is representable
        let s = sel("m", "s", at);
        assert!(is_restorable(Some(&s), at)); // zero delta: the fresh boundary
        assert!(!is_restorable(Some(&s), at - 1)); // 1 ms backwards
        assert!(!is_restorable(Some(&s), at - 6 * 3_600_000)); // RTC six hours ahead
    }
}
