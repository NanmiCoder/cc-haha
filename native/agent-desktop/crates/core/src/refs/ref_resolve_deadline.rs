use std::time::Duration;

use serde_json::json;

use crate::{
    AdapterError, Deadline, ErrorCode, PlatformAdapter, RefEntry,
    refs::resolve_attempt_outcome::ResolveAttemptOutcome,
};

pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(100);
const RESOLVE_ATTEMPT: Duration = Duration::from_millis(4_000);

/// Runs one resolve attempt, bounded to 4 s or the remaining deadline.
///
/// A full-tree search costs what a full snapshot costs (a complete search of
/// Task Manager measured 2.6 s), so a shorter slice cuts every attempt off
/// mid-search and the verdict never settles. The slice stays under the 5 s
/// default outer budget so a re-attempt still fits.
pub(crate) fn resolve_within_deadline(
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    deadline: Deadline,
) -> ResolveAttemptOutcome {
    if deadline.remaining_slice(RESOLVE_ATTEMPT).is_err() {
        return ResolveAttemptOutcome::DeadlinePassed;
    }
    match adapter.resolve_element_strict(entry, deadline.capped(RESOLVE_ATTEMPT)) {
        Ok(_) if deadline.is_expired() => ResolveAttemptOutcome::DeadlinePassed,
        Ok(handle) => ResolveAttemptOutcome::Resolved(handle),
        Err(error) => classify_error(error, deadline),
    }
}

fn classify_error(error: AdapterError, deadline: Deadline) -> ResolveAttemptOutcome {
    if error.code != ErrorCode::Timeout {
        return ResolveAttemptOutcome::Failed(error);
    }
    if !error.permits_retry_by_default()
        || error.disposition.retry() == crate::RetryDisposition::Unsafe
    {
        return ResolveAttemptOutcome::Failed(error);
    }
    if deadline.is_expired() {
        return ResolveAttemptOutcome::DeadlinePassed;
    }
    ResolveAttemptOutcome::Failed(mark_retryable(error))
}

fn mark_retryable(mut error: AdapterError) -> AdapterError {
    let mut details = error.details.take().unwrap_or_else(|| json!({}));
    if let Some(object) = details.as_object_mut() {
        object.insert("retryable".into(), true.into());
    } else {
        details = json!({
            "error_details": details,
            "retryable": true,
        });
    }
    error.with_details(details)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn per_attempt_timeout_is_retryable_while_outer_deadline_remains() {
        let error = AdapterError::timeout("strict resolution slice expired")
            .with_details(json!({ "kind": "deadline" }));

        let ResolveAttemptOutcome::Failed(error) =
            classify_error(error, Deadline::after(1_000).unwrap())
        else {
            panic!("per-attempt timeout must remain inside the outer poll loop");
        };

        assert!(error.is_explicitly_retryable());
        assert_eq!(error.details.unwrap()["kind"], "deadline");
    }

    #[test]
    fn explicit_non_retryable_timeout_remains_terminal() {
        let error = AdapterError::timeout("deterministic limit")
            .with_details(json!({ "retryable": false }));

        let ResolveAttemptOutcome::Failed(error) =
            classify_error(error, Deadline::after(1_000).unwrap())
        else {
            panic!("explicit non-retryable timeout must remain terminal");
        };

        assert!(!error.permits_retry_by_default());
    }

    #[test]
    fn uncertain_timeout_remains_terminal_with_stronger_delivery_evidence() {
        let error = AdapterError::timeout("delivery is uncertain")
            .with_disposition(crate::DeliverySemantics::uncertain());

        let ResolveAttemptOutcome::Failed(error) =
            classify_error(error, Deadline::after(1_000).unwrap())
        else {
            panic!("delivery-uncertain timeout must remain terminal");
        };

        assert_eq!(error.disposition, crate::DeliverySemantics::uncertain());
        assert!(!error.is_explicitly_retryable());
    }

    #[test]
    fn outer_deadline_owns_the_terminal_timeout_shape() {
        let started = Instant::now() - Duration::from_millis(10);
        let deadline = Deadline::at(started, 1).unwrap();

        assert!(matches!(
            classify_error(AdapterError::timeout("attempt expired"), deadline),
            ResolveAttemptOutcome::DeadlinePassed
        ));
    }
}
