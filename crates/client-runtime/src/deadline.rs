//! Deadlines and cancellation — the primitives every bounded network stage
//! shares. Port of `apps/mobile/src/core/deadline.ts` (CDX-086).
//!
//! The rule these exist to enforce: EVERY stage of a network operation carries
//! a deadline and honours a cancel. A stage that could hang forever pins the
//! composer's spinner because it only clears when the whole chain settles.
//!
//! `with_deadline` here leans on `tokio::time::timeout` — dropping the wrapped
//! future on timeout is the teardown (no explicit `onTimeout` callback needed,
//! unlike the JS `FileReader`/`AbortController` version). Caller cancellation is
//! a `tokio_util::sync::CancellationToken`.

use std::fmt;
use std::future::Future;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

/// What a bounded stage failed with — distinguishable at every call site so a
/// cancel never raises an error banner and a stall reads differently from a
/// rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageError {
    /// The stage did not settle inside its budget.
    Timeout { label: String, ms: u64 },
    /// The caller cancelled (the composer's ✕).
    Cancelled { label: String },
    /// The stage itself failed.
    Failed(String),
}

impl StageError {
    /// A cancel must not be retried and must not surface as an error.
    pub fn is_cancelled(&self) -> bool {
        matches!(self, StageError::Cancelled { .. })
    }

    pub fn is_timeout(&self) -> bool {
        matches!(self, StageError::Timeout { .. })
    }
}

impl fmt::Display for StageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StageError::Timeout { label, ms } => write!(f, "{label} timed out after {ms} ms"),
            StageError::Cancelled { label } => write!(f, "{label} cancelled"),
            StageError::Failed(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for StageError {}

/// Milliseconds left of `budget_ms` since `started_at_ms`, floored at 0. Lets a
/// multi-attempt stage share ONE wall-clock budget instead of granting each
/// attempt a fresh one — N attempts × a per-attempt timeout is how a "bounded"
/// operation still takes minutes.
pub fn remaining_budget(started_at_ms: u64, budget_ms: u64, now_ms: u64) -> u64 {
    budget_ms.saturating_sub(now_ms.saturating_sub(started_at_ms))
}

/// Resolve `work`, or fail with [`StageError::Timeout`] if it has not settled
/// inside `ms`. The wrapped future is dropped on timeout.
pub async fn with_deadline<F>(work: F, ms: u64, label: &str) -> Result<F::Output, StageError>
where
    F: Future,
{
    match tokio::time::timeout(Duration::from_millis(ms), work).await {
        Ok(value) => Ok(value),
        Err(_) => Err(StageError::Timeout {
            label: label.to_string(),
            ms,
        }),
    }
}

/// `Err(Cancelled)` if the caller has already cancelled. Call before every
/// irreversible step.
pub fn bail_if_cancelled(token: &CancellationToken, label: &str) -> Result<(), StageError> {
    if token.is_cancelled() {
        Err(StageError::Cancelled {
            label: label.to_string(),
        })
    } else {
        Ok(())
    }
}

/// Race `work` against cancellation: `Err(Cancelled)` the moment the token
/// fires, otherwise the future's own result.
pub async fn with_cancel<F>(
    work: F,
    token: &CancellationToken,
    label: &str,
) -> Result<F::Output, StageError>
where
    F: Future,
{
    tokio::select! {
        biased;
        () = token.cancelled() => Err(StageError::Cancelled { label: label.to_string() }),
        value = work => Ok(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaining_budget_math() {
        assert_eq!(remaining_budget(1_000, 5_000, 1_000), 5_000);
        assert_eq!(remaining_budget(1_000, 5_000, 3_500), 2_500);
        assert_eq!(remaining_budget(1_000, 5_000, 9_000), 0); // exhausted, floored
        assert_eq!(remaining_budget(5_000, 5_000, 1_000), 5_000); // clock went backwards
    }

    #[test]
    fn stage_error_display_and_predicates() {
        let t = StageError::Timeout { label: "Blossom upload".into(), ms: 45_000 };
        assert_eq!(t.to_string(), "Blossom upload timed out after 45000 ms");
        assert!(t.is_timeout() && !t.is_cancelled());

        let c = StageError::Cancelled { label: "Blossom upload".into() };
        assert_eq!(c.to_string(), "Blossom upload cancelled");
        assert!(c.is_cancelled());

        assert_eq!(StageError::Failed("nope".into()).to_string(), "nope");
    }

    #[tokio::test(start_paused = true)]
    async fn with_deadline_passes_a_fast_result_and_trips_on_a_slow_one() {
        let ok = with_deadline(async { 42 }, 1_000, "quick").await;
        assert_eq!(ok, Ok(42));

        let slow = with_deadline(
            tokio::time::sleep(Duration::from_secs(10)),
            1_000,
            "Blossom upload",
        )
        .await;
        assert_eq!(
            slow,
            Err(StageError::Timeout { label: "Blossom upload".into(), ms: 1_000 })
        );
    }

    #[tokio::test]
    async fn cancellation_is_observed_before_and_during() {
        let token = CancellationToken::new();
        assert!(bail_if_cancelled(&token, "upload").is_ok());
        token.cancel();
        assert_eq!(
            bail_if_cancelled(&token, "upload"),
            Err(StageError::Cancelled { label: "upload".into() })
        );

        // with_cancel returns the work's result when the token stays quiet…
        let fresh = CancellationToken::new();
        assert_eq!(with_cancel(async { 7 }, &fresh, "x").await, Ok(7));
        // …and Cancelled once it fires against a pending future
        let firing = CancellationToken::new();
        firing.cancel();
        let out = with_cancel(std::future::pending::<()>(), &firing, "x").await;
        assert_eq!(out, Err(StageError::Cancelled { label: "x".into() }));
    }
}
