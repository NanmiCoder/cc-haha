use agent_desktop_core::{AdapterError, DeliveryDisposition, RetryDisposition};

use super::ReleaseState;

const SUGGESTION: &str = "inspect before retrying";

#[test]
fn nothing_committed_reports_not_delivered_and_stays_safe_to_retry() {
    let state = ReleaseState::default();

    let error = state.enrich_error(AdapterError::internal("pre-injection failure"), SUGGESTION);

    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(error.disposition.retry(), RetryDisposition::Safe);
    assert!(error.details.is_none());
}

#[test]
fn a_committed_injection_reports_delivered_unverified_and_is_unsafe_to_retry() {
    let mut state = ReleaseState::default();
    state.arm();
    state.mark_delivered();

    let error = state.enrich_error(AdapterError::timeout("deadline"), SUGGESTION);

    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
    assert_eq!(error.disposition.retry(), RetryDisposition::Unsafe);
    let details = error.details.expect("committed injection reports evidence");
    assert_eq!(details["delivered_events"], 1);
    assert_eq!(details["emergency_release_posted"], true);
    assert_eq!(details["emergency_release_acknowledged"], false);
}

#[test]
fn a_disarmed_guard_reports_delivery_without_claiming_an_emergency_release() {
    let mut state = ReleaseState::default();
    state.arm();
    state.mark_delivered();
    state.mark_delivered();
    state.disarm();

    let error = state.enrich_error(AdapterError::timeout("after clean release"), SUGGESTION);

    let details = error.details.expect("committed injection reports evidence");
    assert_eq!(details["delivered_events"], 2);
    assert!(details.get("emergency_release_posted").is_none());
}

#[test]
fn arming_alone_does_not_claim_delivery() {
    let mut state = ReleaseState::default();
    state.arm();

    assert!(state.should_release());
    assert_eq!(state.delivered_units(), 0);
    let error = state.enrich_error(
        AdapterError::internal("armed but nothing posted"),
        SUGGESTION,
    );
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}
