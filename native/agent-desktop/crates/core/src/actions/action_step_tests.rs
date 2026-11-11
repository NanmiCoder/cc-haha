use super::ActionStep;
use crate::actions::step_mechanism::StepMechanism;
use crate::trace::trace_sanitize::sanitize_trace_value;
use serde_json::json;

#[test]
fn legacy_action_step_json_round_trips_without_new_fields() {
    let legacy = r#"{"label":"AXPress","outcome":"succeeded"}"#;
    let step: ActionStep = serde_json::from_str(legacy).unwrap();
    assert_eq!(step.label(), "AXPress");
    assert!(step.mechanism().is_none());
    assert!(step.verified().is_none());
    let round_trip = serde_json::to_value(&step).unwrap();
    let legacy_value: serde_json::Value = serde_json::from_str(legacy).unwrap();
    assert_eq!(round_trip, legacy_value);
}

#[test]
fn action_step_serializes_mechanism_and_verified() {
    let step = ActionStep::succeeded("verified_press")
        .with_mechanism(StepMechanism::SemanticApi)
        .with_verified(true);
    let value = serde_json::to_value(&step).unwrap();
    assert_eq!(value["mechanism"], "semantic_api");
    assert_eq!(value["verified"], true);
}

#[test]
fn action_step_omits_absent_mechanism_and_verified() {
    let step = ActionStep::skipped("AXConfirm");
    let value = serde_json::to_value(&step).unwrap();
    assert!(value.get("mechanism").is_none());
    assert!(value.get("verified").is_none());
}

#[test]
fn trace_preserves_mechanism_and_verified() {
    let value = sanitize_trace_value(json!({
        "steps": [{
            "label": "AXPress",
            "outcome": "succeeded",
            "mechanism": "semantic_api",
            "verified": true
        }]
    }));
    assert_eq!(value["steps"][0]["mechanism"], "semantic_api");
    assert_eq!(value["steps"][0]["verified"], true);
}
