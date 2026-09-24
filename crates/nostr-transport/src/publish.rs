//! Publish verdicts (CDX-086): what actually happened to one event published
//! to the relay set. A boolean collapsed two opposite outcomes — "written to
//! an open socket but no OK in time" (almost certainly delivered) and
//! "no relay reachable" — into one `false`; these types keep them apart.

/// What actually happened to a publish. The boolean this replaces collapsed two
/// opposite outcomes into `false` and got one of them backwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishVerdict {
    /// A relay returned OK — delivered, confirmed.
    Accepted,
    /// The frame WAS written to an open socket but no OK arrived in the publish
    /// timeout. Very probably delivered; treating it as failure is the
    /// stuck-upload bug.
    Unconfirmed,
    /// A relay refused (`rate-limited:`, `blocked:`, `pow:`). Retrying the same
    /// event will not help.
    Rejected,
    /// No relay could even be reached.
    Unreachable,
}

impl PublishVerdict {
    /// Severity — the softest surviving verdict across relays wins (CDX-086).
    fn rank(self) -> u8 {
        match self {
            Self::Accepted => 0,
            Self::Unconfirmed => 1,
            Self::Rejected => 2,
            Self::Unreachable => 3,
        }
    }

    /// `accepted` and `unconfirmed` both mean the bridge has it (or almost
    /// certainly does) — the frame reached an open socket.
    pub fn is_delivered(self) -> bool {
        matches!(self, Self::Accepted | Self::Unconfirmed)
    }
}

/// One relay's publish outcome plus any relay-reported reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishResult {
    pub verdict: PublishVerdict,
    pub detail: Option<String>,
}

fn detail_of(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Classify ONE relay's publish outcome (CDX-086). `Ok(reason)` is the relay's
/// OK message (usually empty); `Err(msg)` is a rejection or timeout string.
///
/// - `Ok("connection failure: …")` — the relay could not be reached at all. The
///   transport resolves rather than rejects these, which is why the old boolean
///   reported an unreachable relay as success.
/// - `Err("… publish timed out …")` — the frame WAS written to an open socket
///   but no OK arrived inside the publish timeout. Very probably delivered.
/// - any other `Err` — the relay refused the event.
pub fn classify_publish(outcome: Result<&str, &str>) -> PublishResult {
    match outcome {
        Ok(value) => {
            if value.to_ascii_lowercase().starts_with("connection failure:") {
                PublishResult {
                    verdict: PublishVerdict::Unreachable,
                    detail: Some(value.to_string()),
                }
            } else {
                PublishResult {
                    verdict: PublishVerdict::Accepted,
                    detail: detail_of(value),
                }
            }
        }
        Err(reason) => {
            if reason.to_ascii_lowercase().contains("publish timed out") {
                PublishResult {
                    verdict: PublishVerdict::Unconfirmed,
                    detail: Some(reason.to_string()),
                }
            } else {
                PublishResult {
                    verdict: PublishVerdict::Rejected,
                    detail: Some(reason.to_string()),
                }
            }
        }
    }
}

/// Combine per-relay results into the verdict for the publish — the softest
/// surviving verdict wins (CDX-086). An empty slice is `unreachable`.
pub fn combine_publish(results: &[PublishResult]) -> PublishResult {
    results
        .iter()
        .min_by_key(|r| r.verdict.rank())
        .cloned()
        .unwrap_or(PublishResult {
            verdict: PublishVerdict::Unreachable,
            detail: Some("no relay settled".to_string()),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_publish_decodes_each_relay_outcome() {
        assert_eq!(classify_publish(Ok("")).verdict, PublishVerdict::Accepted);
        assert_eq!(
            classify_publish(Ok("connection failure: ECONNREFUSED")).verdict,
            PublishVerdict::Unreachable
        );
        assert_eq!(
            classify_publish(Err("relay: publish timed out")).verdict,
            PublishVerdict::Unconfirmed
        );
        assert_eq!(
            classify_publish(Err("rate-limited: slow down")).verdict,
            PublishVerdict::Rejected
        );
        assert_eq!(
            classify_publish(Err("blocked: not on allowlist")).verdict,
            PublishVerdict::Rejected
        );
    }

    #[test]
    fn combine_publish_takes_the_softest_verdict() {
        let mk = |v| PublishResult { verdict: v, detail: None };
        assert_eq!(
            combine_publish(&[
                mk(PublishVerdict::Rejected),
                mk(PublishVerdict::Accepted),
                mk(PublishVerdict::Unreachable),
            ])
            .verdict,
            PublishVerdict::Accepted
        );
        assert_eq!(
            combine_publish(&[mk(PublishVerdict::Rejected), mk(PublishVerdict::Unreachable)])
                .verdict,
            PublishVerdict::Rejected
        );
        assert_eq!(combine_publish(&[]).verdict, PublishVerdict::Unreachable);
    }

    #[test]
    fn delivered_covers_accepted_and_unconfirmed_only() {
        assert!(PublishVerdict::Accepted.is_delivered());
        assert!(PublishVerdict::Unconfirmed.is_delivered());
        assert!(!PublishVerdict::Rejected.is_delivered());
        assert!(!PublishVerdict::Unreachable.is_delivered());
    }
}
