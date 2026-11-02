use std::cell::Cell;

use agent_desktop_core::ErrorCode;

use super::*;

use crate::system::fixture::test_time::deadline;
use crate::system::runtime::hresult::{E_FAIL, E_UNEXPECTED};
use crate::tree::automation::{UiaFailure, uia_failure_error};

fn race_error() -> AdapterError {
    AdapterError::new(ErrorCode::WindowNotFound, "forced race")
}

fn is_window_not_found(error: &AdapterError) -> bool {
    error.code == ErrorCode::WindowNotFound
}

#[test]
fn a_successful_first_attempt_never_retries() {
    let calls = Cell::new(0u32);
    let result = retry_transient_window_race(deadline(10_000), is_window_not_found, || {
        calls.set(calls.get() + 1);
        Ok::<_, AdapterError>(42)
    });

    assert_eq!(result.expect("attempt succeeded"), 42);
    assert_eq!(calls.get(), 1, "a first-try success must not retry");
}

#[test]
fn a_race_is_retried_until_it_clears() {
    let calls = Cell::new(0u32);
    let result = retry_transient_window_race(deadline(10_000), is_window_not_found, || {
        calls.set(calls.get() + 1);
        if calls.get() < 3 {
            Err(race_error())
        } else {
            Ok::<_, AdapterError>("cleared")
        }
    });

    assert_eq!(
        result.expect("the race clears before the budget"),
        "cleared"
    );
    assert_eq!(calls.get(), 3, "two races plus the attempt that clears");
}

#[test]
fn a_non_race_error_returns_immediately_without_retrying() {
    let calls = Cell::new(0u32);
    let result = retry_transient_window_race(deadline(10_000), is_window_not_found, || {
        calls.set(calls.get() + 1);
        Err::<u32, _>(AdapterError::internal("not a race at all"))
    });

    let error = result.expect_err("a non-race error must propagate");
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(calls.get(), 1, "a non-race error must not be retried");
}

#[test]
fn a_persistent_race_exhausts_every_attempt_and_returns_it_unchanged() {
    let calls = Cell::new(0u32);
    let result = retry_transient_window_race(deadline(10_000), is_window_not_found, || {
        calls.set(calls.get() + 1);
        Err::<u32, _>(race_error())
    });

    let error = result.expect_err("a race that never clears must exhaust the budget");
    assert_eq!(error.code, ErrorCode::WindowNotFound);
    assert_eq!(calls.get(), LISTING_RACE_ATTEMPTS);
}

#[test]
fn an_already_expired_deadline_returns_timeout_without_ever_attempting() {
    let calls = Cell::new(0u32);
    let expired = Deadline::after(0).expect("a zero-timeout deadline is constructible");

    let result = retry_transient_window_race(expired, is_window_not_found, || {
        calls.set(calls.get() + 1);
        Ok::<_, AdapterError>(())
    });

    let error = result.expect_err("an already-expired deadline must refuse before attempting");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        calls.get(),
        0,
        "an expired deadline must never call attempt"
    );
}

#[test]
fn a_teardown_read_failure_survives_narrowing_as_a_retryable_error() {
    let error = narrow_to_permitted_codes(uia_failure_error(
        UiaFailure::Hresult(E_UNEXPECTED),
        "search a candidate window for a reachable menu element",
    ));

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(error.is_transient_incomplete_read());
    assert!(error.permits_retry_by_default());
}

#[test]
fn a_terminal_read_failure_stays_non_retryable_after_narrowing() {
    let error = narrow_to_permitted_codes(uia_failure_error(
        UiaFailure::Hresult(E_FAIL),
        "search a candidate window for a reachable menu element",
    ));

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(!error.is_transient_incomplete_read());
    assert!(!error.permits_retry_by_default());
}
