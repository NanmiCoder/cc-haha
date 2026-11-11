use super::{focus_from_delivery, headless_denied};
use agent_desktop_core::{
    DeliveryDisposition, ErrorCode, InteractionPolicy, RetryDisposition, StepMechanism,
};

#[test]
fn headless_set_focus_is_policy_denied_not_delivered() {
    let error = headless_denied(InteractionPolicy::headless());
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(error.disposition.retry(), RetryDisposition::Safe);
    let suggestion = error.suggestion.as_deref().unwrap_or("");
    assert!(
        suggestion.contains("--headed"),
        "suggestion must name --headed: {suggestion}"
    );
    let details = error.details.expect("details");
    assert_eq!(details["foreground_effect"], true);
    let evidence = details["evidence"].as_array().expect("evidence array");
    assert!(evidence.iter().any(|row| row.as_str() == Some("A3-4")));
    assert!(evidence.iter().any(|row| row.as_str() == Some("A19-5")));
}

#[test]
fn headed_verified_compare_true_tags_verified() {
    let result =
        focus_from_delivery(InteractionPolicy::headed(), Ok(true), true).expect("verified focus");
    assert_eq!(result.steps[0].verified(), Some(true));
    assert_eq!(
        result.steps[0].mechanism(),
        Some(StepMechanism::SemanticApi)
    );
    assert_eq!(result.steps[0].label(), "UIElement.SetFocus");
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredVerified
    );
}

#[test]
fn headed_verified_compare_false_tags_unverified() {
    let result = focus_from_delivery(InteractionPolicy::headed(), Ok(true), false)
        .expect("unverified focus");
    assert_eq!(result.steps[0].verified(), Some(false));
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
}

#[test]
fn headed_absent_affordance_is_not_delivered() {
    let error = focus_from_delivery(InteractionPolicy::headed(), Ok(false), false)
        .expect_err("absent focus");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn focus_from_delivery_respects_headless_gate() {
    let error = focus_from_delivery(InteractionPolicy::headless(), Ok(true), true)
        .expect_err("headless denied");
    assert_eq!(error.code, ErrorCode::PolicyDenied);
}
