use super::{SetValuePlan, parse_finite_f64, set_value_judged_for};
use crate::actions::chain::DeliveryOutcome;
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{
    Action, ActionStepOutcome, DeliveryDisposition, ErrorCode, InteractionPolicy,
};
use std::cell::Cell;

#[test]
fn set_value_verified_when_readback_equals() {
    let value = Cell::new(0u8);
    let steps = set_value_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        SetValuePlan {
            value: "hello",
            value_writable: true,
            range_available: false,
        },
        || {
            value.set(value.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
        || Ok(DeliveryOutcome::NotDelivered),
    )
    .expect("set-value");
    assert_eq!(value.get(), 1);
    assert_eq!(steps.len(), 1);
    assert!(matches!(steps[0].outcome, ActionStepOutcome::Succeeded));
    assert_eq!(steps[0].verified(), Some(true));
    let result =
        agent_desktop_core::ActionResult::from_execution(&Action::SetValue("hello".into()), steps);
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredVerified
    );
}

#[test]
fn unequal_readback_stops_without_reaching_range_value() {
    let value_calls = Cell::new(0u8);
    let range_calls = Cell::new(0u8);
    let steps = set_value_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        SetValuePlan {
            value: "77",
            value_writable: true,
            range_available: true,
        },
        || {
            value_calls.set(value_calls.get() + 1);
            Ok(DeliveryOutcome::DeliveredUnverified)
        },
        || {
            range_calls.set(range_calls.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
    )
    .expect("an unverified delivery terminates the chain");
    assert_eq!(value_calls.get(), 1);
    assert_eq!(range_calls.get(), 0);
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].label(), "ValuePattern.SetValue");
    assert_eq!(steps[0].verified(), Some(false));
}

#[test]
fn range_value_numeric_on_value_less_control() {
    let steps = set_value_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        SetValuePlan {
            value: "77",
            value_writable: false,
            range_available: true,
        },
        || Ok(DeliveryOutcome::DeliveredVerified),
        || Ok(DeliveryOutcome::DeliveredVerified),
    )
    .expect("range only");
    assert_eq!(steps[0].label(), "ValuePattern.SetValue");
    assert!(matches!(steps[0].outcome, ActionStepOutcome::Skipped));
    assert_eq!(steps[1].verified(), Some(true));
}

#[test]
fn unparsable_range_value_exhausts_honestly() {
    let range_calls = Cell::new(0u8);
    let error = set_value_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        SetValuePlan {
            value: "not-a-number",
            value_writable: false,
            range_available: true,
        },
        || Ok(DeliveryOutcome::NotDelivered),
        || {
            range_calls.set(range_calls.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
    )
    .expect_err("exhausted");
    assert_eq!(range_calls.get(), 0);
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn parse_finite_rejects_nan_and_non_numeric() {
    assert_eq!(parse_finite_f64("77"), Some(77.0));
    assert!(parse_finite_f64("abc").is_none());
    assert!(parse_finite_f64("NaN").is_none());
    assert!(parse_finite_f64("inf").is_none());
}

#[test]
fn error_envelope_carries_value_chars_never_marker_text() {
    const MARKER: &str = "zzsetvaluemarkerzz";
    let error = set_value_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        SetValuePlan {
            value: MARKER,
            value_writable: false,
            range_available: false,
        },
        || Ok(DeliveryOutcome::NotDelivered),
        || Ok(DeliveryOutcome::NotDelivered),
    )
    .expect_err("exhausted");
    assert!(!error.message.contains(MARKER));
    assert!(
        !error
            .platform_detail
            .as_deref()
            .unwrap_or("")
            .contains(MARKER)
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("value_chars")),
        Some(&serde_json::json!(MARKER.chars().count()))
    );
}
