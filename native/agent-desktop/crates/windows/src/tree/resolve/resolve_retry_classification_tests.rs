//! Which failures the resolution loop retries, and which diagnosis survives
//! the deadline.
//!
//! Split from `resolve_retry_tests.rs`, which sits near the per-file line cap.
//! The tests there drive the loop's shape - retries happen, settled failures do
//! not - while these pin the two classification arms that decide *which*
//! failure is which, each of which could be deleted with the rest of the suite
//! still green.

use crate::system::fixture::test_time::deadline;
use crate::tree::automation::{ERR_INACTIVE, ERR_TIMEOUT, UiaFailure, uia_failure_error};
use crate::tree::resolve::retry_incomplete_until;
use crate::tree::test_support::unreachable_handle;
use agent_desktop_core::{AdapterError, ErrorCode};

/// A provider's own transport timeout is retried, driven through the real
/// classifier rather than a hand-built error.
///
/// `ERR_TIMEOUT` classifies `ErrorCode::Timeout` with the retryable stamp, and
/// that is a per-call transport timeout inside the operation's budget - not the
/// budget running out. Dropping `Timeout` from
/// `is_retryable_resolution_error`'s code set makes this settle on the first
/// attempt, which is the whole retry tier the anchor descent depends on.
///
/// The attempt count is the assertion: an error code alone would be identical
/// either way, since the loop returns the same error it was handed once it
/// stops retrying.
#[test]
fn a_providers_own_transport_timeout_is_retried_within_the_budget() {
    let error = uia_failure_error(UiaFailure::Sentinel(ERR_TIMEOUT), "read a property");
    assert_eq!(
        error.code,
        ErrorCode::Timeout,
        "the classifier must still call this a timeout for this test to mean anything"
    );
    assert!(
        error.is_explicitly_retryable(),
        "the classifier must still stamp this retryable"
    );

    let mut attempts = 0;
    let result = retry_incomplete_until(deadline(5_000), || {
        attempts += 1;
        if attempts < 3 {
            Err(uia_failure_error(
                UiaFailure::Sentinel(ERR_TIMEOUT),
                "read a property",
            ))
        } else {
            Ok(unreachable_handle())
        }
    });

    assert!(result.is_ok(), "the loop must reach the recovered attempt");
    assert_eq!(attempts, 3);
}

/// The unresponsive family is retried the same way, so the assertion above is
/// pinning the timeout arm specifically rather than a code set that happens to
/// admit everything.
#[test]
fn an_unresponsive_provider_is_retried_on_the_same_tier() {
    let mut attempts = 0;
    let result = retry_incomplete_until(deadline(5_000), || {
        attempts += 1;
        if attempts < 2 {
            Err(uia_failure_error(
                UiaFailure::Sentinel(ERR_INACTIVE),
                "read a property",
            ))
        } else {
            Ok(unreachable_handle())
        }
    });

    assert!(result.is_ok());
    assert_eq!(attempts, 2);
}

/// A settled failure is still refused by the same code set, which is the
/// control that stops the two tests above from passing on a loop that retries
/// everything.
#[test]
fn a_settled_absence_is_not_admitted_by_the_retry_code_set() {
    let mut attempts = 0;
    let result = retry_incomplete_until(deadline(5_000), || {
        attempts += 1;
        Err(uia_failure_error(
            UiaFailure::Sentinel(crate::tree::automation::ERR_INVALID_ARG),
            "read a property",
        ))
    });

    assert_eq!(attempts, 1);
    match result {
        Err(error) => assert_eq!(error.code, ErrorCode::InvalidArgs),
        Ok(_) => panic!("a settled absence must not resolve"),
    }
}

/// A timeout arriving *after* an incomplete diagnosis returns the diagnosis,
/// stamped, rather than the bare timeout.
///
/// This is the arm a caller reads to find out why the retries ran out. Deleting
/// it leaves the loop's fall-through returning the timeout verbatim, which the
/// no-prior-diagnosis test cannot distinguish because that test never records
/// an incomplete in the first place.
#[test]
fn a_timeout_after_an_incomplete_returns_the_stamped_diagnosis_not_the_timeout() {
    let incomplete = AdapterError::new(ErrorCode::AppUnresponsive, "identity unknown")
        .with_details(serde_json::json!({
            "kind": "resolution_identity_unknown",
            "retryable": true,
            "complete": false,
        }));

    let mut attempts = 0;
    let result = retry_incomplete_until(deadline(5_000), || {
        attempts += 1;
        if attempts == 1 {
            Err(incomplete.clone())
        } else {
            Err(AdapterError::new(ErrorCode::Timeout, "the budget ran out"))
        }
    });

    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("expected the diagnosis, got a resolved handle"),
    };
    assert_eq!(
        error.code,
        ErrorCode::AppUnresponsive,
        "the incomplete diagnosis must survive the timeout that ended the loop"
    );
    let details = error.details.expect("the diagnosis carries its details");
    assert_eq!(details["kind"], "resolution_identity_unknown");
    assert_eq!(details["deadline_elapsed"], serde_json::json!(true));
    assert_eq!(attempts, 2);
}

/// The same arm with nothing recorded before it returns the timeout itself, so
/// the substitution above is conditional on there being a diagnosis to
/// substitute rather than unconditional.
#[test]
fn a_timeout_with_no_prior_incomplete_is_returned_as_itself() {
    let result = retry_incomplete_until(deadline(200), || {
        Err(AdapterError::new(ErrorCode::Timeout, "the budget ran out"))
    });

    match result {
        Err(error) => {
            assert_eq!(error.code, ErrorCode::Timeout);
            assert_eq!(
                error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("deadline_elapsed")),
                None,
                "there was no diagnosis to stamp"
            );
        }
        Ok(_) => panic!("expected the timeout"),
    }
}
