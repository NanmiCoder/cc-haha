use crate::actions::chain::{DeliveryOutcome, build_step};
use crate::actions::mutation::classify_mutation;
use crate::system::runtime::hresult::{
    E_ACCESSDENIED, E_INVALIDARG, RPC_E_SERVERFAULT, UIA_E_ELEMENTNOTAVAILABLE,
    UIA_E_ELEMENTNOTENABLED, UIA_E_INVALIDOPERATION, UIA_E_TIMEOUT,
};
use crate::tree::automation::UiaFailure;
use agent_desktop_core::{Action, ActionResult, AppError, DeliverySemantics, ErrorPayload};
use serde_json::Value;

fn succeeded_step(label: &'static str, verified: bool) -> agent_desktop_core::ActionStep {
    build_step(
        label,
        if verified {
            DeliveryOutcome::DeliveredVerified
        } else {
            DeliveryOutcome::DeliveredUnverified
        },
    )
}

fn skipped_step(label: &'static str) -> agent_desktop_core::ActionStep {
    build_step(label, DeliveryOutcome::NotDelivered)
}

fn satisfied_step(label: &'static str) -> agent_desktop_core::ActionStep {
    build_step(label, DeliveryOutcome::SatisfiedNoDelivery)
}

fn assert_disposition_matches_projection(json: &Value, semantics: DeliverySemantics) {
    let projected = serde_json::to_value(semantics).expect("disposition serializes");
    assert_eq!(
        json["disposition"], projected,
        "wire disposition must equal DeliverySemantics projection"
    );
}

fn serialize_result(
    action: &Action,
    steps: Vec<agent_desktop_core::ActionStep>,
) -> (ActionResult, Value) {
    let result = ActionResult::from_execution(action, steps);
    let json = serde_json::to_value(&result).expect("ActionResult serializes");
    (result, json)
}

#[test]
fn succeeded_step_wire_uses_semantic_api_and_succeeded() {
    let (result, json) = serialize_result(
        &Action::Click,
        vec![succeeded_step("InvokePattern.Invoke", false)],
    );

    assert_eq!(json["steps"][0]["outcome"], "succeeded");
    assert_eq!(json["steps"][0]["mechanism"], "semantic_api");
    assert_eq!(json["steps"][0]["verified"], false);
    assert_eq!(json["steps"][0]["label"], "InvokePattern.Invoke");
    assert_disposition_matches_projection(&json, result.disposition());
    assert_eq!(json["disposition"]["delivery"], "delivered_unverified");
    assert_eq!(json["disposition"]["retry"], "unsafe");
}

#[test]
fn skipped_step_wire_uses_semantic_api_and_skipped() {
    let (result, json) = serialize_result(
        &Action::Click,
        vec![
            skipped_step("InvokePattern.Invoke"),
            succeeded_step("LegacyIAccessible.DoDefaultAction", false),
        ],
    );

    assert_eq!(json["steps"][0]["outcome"], "skipped");
    assert_eq!(json["steps"][0]["mechanism"], "semantic_api");
    assert!(json["steps"][0].get("verified").is_none());
    assert_eq!(json["steps"][1]["outcome"], "succeeded");
    assert_eq!(json["steps"][1]["mechanism"], "semantic_api");
    assert_disposition_matches_projection(&json, result.disposition());
    assert_eq!(json["disposition"]["delivery"], "delivered_unverified");
    assert_eq!(json["disposition"]["retry"], "unsafe");
}

#[test]
fn satisfied_without_delivery_wire_is_not_delivered_safe() {
    let (result, json) = serialize_result(&Action::Check, vec![satisfied_step("AlreadyInState")]);

    assert_eq!(json["steps"][0]["outcome"], "skipped");
    assert_eq!(json["steps"][0]["mechanism"], "semantic_api");
    assert_eq!(json["steps"][0]["verified"], true);
    assert!(
        json.get("post_state").is_none(),
        "no-op success omits post_state"
    );
    assert_eq!(result.disposition(), DeliverySemantics::not_delivered());
    assert_disposition_matches_projection(&json, DeliverySemantics::not_delivered());
    assert_eq!(json["disposition"]["delivery"], "not_delivered");
    assert_eq!(json["disposition"]["retry"], "safe");
}

#[test]
fn verified_delivery_wire_is_delivered_verified_unsafe() {
    let (result, json) = serialize_result(
        &Action::SetValue("done".into()),
        vec![succeeded_step("ValuePattern.SetValue", true)],
    );

    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_verified()
    );
    assert_disposition_matches_projection(&json, DeliverySemantics::delivered_verified());
    assert_eq!(json["disposition"]["delivery"], "delivered_verified");
    assert_eq!(json["disposition"]["retry"], "unsafe");
}

fn classify_hresult(code: i32) -> agent_desktop_core::AdapterError {
    classify_mutation("Pattern.Write", "Pattern.Write", &UiaFailure::Hresult(code))
        .expect_err("classifier Err arm")
}

fn error_disposition_json(error: agent_desktop_core::AdapterError) -> Value {
    let payload = ErrorPayload::from_app_error(&AppError::from(error));
    serde_json::to_value(&payload).expect("ErrorPayload serializes")["disposition"].clone()
}

#[test]
fn classifier_error_disposition_wire_matches_projection() {
    let cases: &[(i32, DeliverySemantics)] = &[
        (E_ACCESSDENIED, DeliverySemantics::not_delivered()),
        (
            UIA_E_ELEMENTNOTAVAILABLE,
            DeliverySemantics::not_delivered(),
        ),
        (E_INVALIDARG, DeliverySemantics::not_delivered()),
        (UIA_E_ELEMENTNOTENABLED, DeliverySemantics::not_delivered()),
        (RPC_E_SERVERFAULT, DeliverySemantics::uncertain()),
        (UIA_E_TIMEOUT, DeliverySemantics::uncertain()),
        (UIA_E_INVALIDOPERATION, DeliverySemantics::uncertain()),
    ];

    for &(hresult, expected) in cases {
        let error = classify_hresult(hresult);
        assert_eq!(error.disposition, expected);
        let wire = error_disposition_json(error);
        let projected = serde_json::to_value(expected).expect("projection");
        assert_eq!(wire, projected, "HRESULT {hresult:#x} disposition wire");
    }
}

#[test]
fn perm_denied_error_disposition_is_not_delivered_safe() {
    let wire = error_disposition_json(classify_hresult(E_ACCESSDENIED));
    assert_eq!(wire["delivery"], "not_delivered");
    assert_eq!(wire["retry"], "safe");
}

#[test]
fn app_unresponsive_error_disposition_is_uncertain_unsafe() {
    let wire = error_disposition_json(classify_hresult(RPC_E_SERVERFAULT));
    assert_eq!(wire["delivery"], "delivery_uncertain");
    assert_eq!(wire["retry"], "unsafe");
}

const COST_ARMS: &[&str] = &[
    "Invoke",
    "Toggle",
    "SetValue",
    "Select",
    "Scroll",
    "click_chain_worst_case",
];

fn assert_cost_capture_spread(label: &str, raw: &str) {
    let value: Value = serde_json::from_str(raw).unwrap_or_else(|err| {
        panic!("{label} must parse as JSON: {err}");
    });
    super::assert_cost_arms(label, &value, COST_ARMS);
    assert_eq!(
        value["methodology"], "min-of-seven discard warm-up (A15-13)",
        "{label} methodology"
    );
}

#[test]
fn a19_8_semantic_cost_captures_carry_min_median_max_both_environments() {
    assert_cost_capture_spread(
        "semantic-cost-devbox",
        include_str!(
            "../../../../probes/windows/19-semantic-actions/captures/semantic-cost-devbox.json"
        ),
    );
    assert_cost_capture_spread(
        "semantic-cost-ci",
        include_str!(
            "../../../../probes/windows/19-semantic-actions/captures/semantic-cost-ci.json"
        ),
    );
}

#[test]
fn a18_7_target_pre_read_baseline_still_present_for_shared_primitive() {
    for (label, raw) in [
        (
            "actionability-cost-devbox",
            include_str!(
                "../../../../probes/windows/18-actionability/captures/actionability-cost-devbox.json"
            ),
        ),
        (
            "actionability-cost-ci",
            include_str!(
                "../../../../probes/windows/18-actionability/captures/actionability-cost-ci.json"
            ),
        ),
    ] {
        let value: Value = serde_json::from_str(raw).unwrap_or_else(|err| {
            panic!("{label} must parse as JSON: {err}");
        });
        let entry = value
            .get("target_pre_read")
            .unwrap_or_else(|| panic!("{label} missing target_pre_read"));
        assert!(entry["min_ms"].as_f64().is_some(), "{label} min_ms");
        assert!(entry["median_ms"].as_f64().is_some(), "{label} median_ms");
        assert!(entry["max_ms"].as_f64().is_some(), "{label} max_ms");
    }
}
