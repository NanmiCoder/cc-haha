use super::*;
use agent_desktop_core::{DeliveryDisposition, RetryDisposition};

#[test]
fn ownership_requires_the_clear_contents_change_count() {
    assert!(owns(42, 42));
    assert!(!owns(42, 43));
    assert!(!owns(-1, -1));
}

#[test]
fn ownership_loss_after_clear_is_delivered_and_unsafe_to_retry() {
    let error = delivered_unverified("text", "ownership changed after clearContents");

    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
    assert_eq!(error.disposition.retry(), RetryDisposition::Unsafe);
}

#[test]
fn verified_delivery_after_deadline_is_not_retryable() {
    let deadline = Deadline::after(0).expect("zero-duration deadline is valid");
    let error = ensure_verified_before_return(deadline).expect_err("deadline must expire");

    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveredVerified
    );
    assert_eq!(error.disposition.retry(), RetryDisposition::Unsafe);
}

#[test]
fn cleanup_is_reserved_before_mutation() {
    let deadline = Deadline::after(1_000).expect("deadline is valid");
    let before = deadline.remaining();
    let mutation = reserve_cleanup_budget(deadline).expect("cleanup budget can be reserved");

    let one_ms_of_deadline_rounding = std::time::Duration::from_millis(1);
    assert!(
        mutation.remaining()
            <= before - std::time::Duration::from_millis(250) + one_ms_of_deadline_rounding
    );
}
