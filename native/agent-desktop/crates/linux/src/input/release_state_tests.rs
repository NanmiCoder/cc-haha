use agent_desktop_core::{AdapterError, DeliveryDisposition, RetryDisposition};

use super::ReleaseState;

const SUGGESTION: &str = "inspect before retrying";

#[test]
fn a_disarmed_state_reports_delivery_without_an_emergency_release() {
    let mut state = ReleaseState::default();
    state.arm();
    state.mark_delivered();
    state.disarm();

    let error = state.enrich_error(
        AdapterError::timeout("after a clean release")
            .with_details(serde_json::json!({ "kind": "deadline" })),
        SUGGESTION,
    );

    let details = error.details.expect("delivered input reports evidence");
    assert_eq!(details["kind"], "deadline");
    assert_eq!(details["delivered_events"], 1);
    assert!(details.get("emergency_release_posted").is_none());
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
    assert_eq!(error.disposition.retry(), RetryDisposition::Unsafe);
    assert_eq!(error.suggestion.as_deref(), Some(SUGGESTION));
    assert!(!state.should_release());
}
