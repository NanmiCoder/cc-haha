use crate::actions::physical_click::{ClickGate, ClickSpec, click_from_gate};
use crate::actions::physical_keyboard::{press_key_global, type_text_from_gate};
use crate::actions::physical_target::{
    delivery_point, ensure_headed_click_policy, ensure_keyboard_policy, focus_lost_before_delivery,
};
use crate::input::elevation::evaluate_integrity_gate;
use crate::input::keyboard::reject_standalone_key_state;
use crate::input::mouse::standalone_state_error;
use crate::input::{
    DragReleaseGuard, KeyReleaseGuard, NormalizedPoint, ensure_chunk_budget,
    keyboard_send_fake_sink as key_sink, mouse_send_fake_sink as mouse_sink, preflight_text,
};
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{
    Action, ActionResult, ActionStep, AdapterError, AppError, Deadline, DeliverySemantics,
    ErrorCode, ErrorPayload, InteractionPolicy, KeyCombo, MouseButton, Point, Rect,
};
use serde_json::Value;
use std::time::Duration;

const INTEGRITY_RID_MEDIUM: u32 = 0x2000;
const INTEGRITY_RID_HIGH: u32 = 0x3000;

fn bounds() -> Rect {
    Rect {
        x: 10.0,
        y: 20.0,
        width: 100.0,
        height: 40.0,
    }
}

fn combo() -> KeyCombo {
    KeyCombo {
        key: "a".into(),
        modifiers: vec![],
    }
}

fn error_wire(error: &AdapterError) -> Value {
    serde_json::to_value(ErrorPayload::from_app_error(&AppError::from(error.clone())))
        .expect("ErrorPayload serializes")
}

fn assert_disposition_wire(error: &AdapterError, expected: DeliverySemantics) {
    let wire = error_wire(error);
    let projected = serde_json::to_value(expected).expect("disposition serializes");
    assert_eq!(wire["disposition"], projected, "disposition wire shape");
}

fn assert_code_wire(error: &AdapterError, code: ErrorCode) {
    assert_eq!(error_wire(error)["code"], code.as_str());
}

fn assert_details_keys(error: &AdapterError, keys: &[&str]) {
    let wire = error_wire(error);
    let details = wire["details"].as_object().expect("details object");
    for key in keys {
        assert!(details.contains_key(*key), "missing details.{key}");
    }
}

fn assert_no_forbidden_detail_keys(error: &AdapterError) {
    let forbidden = ["x", "y", "app", "hwnd", "pid", "process_name"];
    if let Some(details) = error_wire(error)["details"].as_object() {
        for key in forbidden {
            assert!(
                !details.contains_key(key),
                "details must not carry app/provider facts: {key}"
            );
        }
    }
}

fn serialize_action_result(action: &Action, steps: Vec<ActionStep>) -> Value {
    let result = ActionResult::from_execution(action, steps);
    serde_json::to_value(&result).expect("ActionResult serializes")
}

fn assert_result_disposition(json: &Value, expected: DeliverySemantics) {
    let projected = serde_json::to_value(expected).expect("disposition serializes");
    assert_eq!(json["disposition"], projected);
}

#[test]
fn physical_type_text_step_wire_uses_physical_synthetic_and_unverified() {
    key_sink::reset();
    let step = type_text_from_gate("hi", true, deadline(5_000), |_| Ok(())).expect("type");

    let json = serialize_action_result(&Action::TypeText("hi".into()), vec![step]);
    assert_eq!(json["steps"][0]["outcome"], "succeeded");
    assert_eq!(json["steps"][0]["mechanism"], "physical_synthetic");
    assert_eq!(json["steps"][0]["verified"], false);
    assert_eq!(json["steps"][0]["label"], "SendInput.type_text");
    assert_result_disposition(&json, DeliverySemantics::delivered_unverified());
}

#[test]
fn physical_click_step_wire_uses_physical_synthetic_and_unverified() {
    mouse_sink::reset();
    let step = click_from_gate(
        ClickGate {
            bounds: bounds(),
            foreground_ready: true,
        },
        None,
        ClickSpec {
            button: MouseButton::Left,
            count: 2,
        },
        deadline(5_000),
    )
    .expect("click");

    let json = serialize_action_result(&Action::DoubleClick, vec![step]);
    assert_eq!(json["steps"][0]["mechanism"], "physical_synthetic");
    assert_eq!(json["steps"][0]["verified"], false);
    assert_eq!(json["steps"][0]["label"], "SendInput.click");
    assert_result_disposition(&json, DeliverySemantics::delivered_unverified());
}

#[test]
fn press_key_global_result_disposition_matches_projection() {
    key_sink::reset();
    let result = press_key_global(&combo(), deadline(5_000)).expect("press");
    let json = serde_json::to_value(&result).expect("serializes");

    assert_eq!(json["steps"][0]["mechanism"], "physical_synthetic");
    assert_result_disposition(&json, result.disposition());
}

#[test]
fn perm_denied_elevation_wire_shape() {
    let error = evaluate_integrity_gate(Some(INTEGRITY_RID_MEDIUM), Some(INTEGRITY_RID_HIGH))
        .expect_err("higher target denied");

    assert_code_wire(&error, ErrorCode::PermDenied);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
    assert_details_keys(&error, &["raw_input_emitted"]);
    assert_eq!(
        error_wire(&error)["platform_detail"]
            .as_str()
            .expect("platform_detail"),
        "COM HRESULT 0x80070005 (E_ACCESSDENIED: Access is denied)"
    );
    assert_no_forbidden_detail_keys(&error);
}

#[test]
fn policy_denied_keyboard_wire_shape() {
    let error = ensure_keyboard_policy(InteractionPolicy::headless()).expect_err("headless");

    assert_code_wire(&error, ErrorCode::PolicyDenied);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
    assert_eq!(error_wire(&error)["disposition"]["retry"], "safe");
    assert!(
        error_wire(&error)["recovery"]["strategy"]
            .as_str()
            .is_some(),
        "POLICY_DENIED carries recovery.strategy"
    );
    assert_no_forbidden_detail_keys(&error);
}

#[test]
fn policy_denied_click_wire_shape() {
    let error = ensure_headed_click_policy(InteractionPolicy::headless()).expect_err("headless");

    assert_code_wire(&error, ErrorCode::PolicyDenied);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
    assert_no_forbidden_detail_keys(&error);
}

#[test]
fn stale_ref_delivery_point_wire_shape() {
    let stale = Point { x: 9.0, y: 30.0 };
    let error = delivery_point(bounds(), Some(&stale)).expect_err("outside bounds");

    assert_code_wire(&error, ErrorCode::StaleRef);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
    assert_no_forbidden_detail_keys(&error);
}

#[test]
fn standalone_mouse_state_wire_shape() {
    let error = standalone_state_error();

    assert_code_wire(&error, ErrorCode::ActionNotSupported);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
    assert_details_keys(
        &error,
        &["raw_input_emitted", "requires_daemon_owned_transaction"],
    );
    assert_no_forbidden_detail_keys(&error);
}

#[test]
fn standalone_key_state_wire_shape() {
    let error = reject_standalone_key_state(&combo(), true).expect_err("held edge");

    assert_code_wire(&error, ErrorCode::ActionNotSupported);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
    assert_details_keys(
        &error,
        &["raw_input_emitted", "requires_daemon_owned_transaction"],
    );
    assert_no_forbidden_detail_keys(&error);
}

#[test]
fn focus_lost_before_delivery_wire_shape() {
    let error = focus_lost_before_delivery();

    assert_code_wire(&error, ErrorCode::ActionFailed);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
    assert_no_forbidden_detail_keys(&error);
}

#[test]
fn drag_abort_error_wire_matches_macos_structure() {
    let mut guard = DragReleaseGuard::new(NormalizedPoint {
        x: 111,
        y: 222,
        virtual_desktop: false,
    });
    guard.arm();
    for _ in 0..4 {
        guard.mark_delivered();
    }
    let error = guard.enrich_error(AdapterError::timeout("deadline"));

    assert_disposition_wire(&error, DeliverySemantics::delivered_unverified());
    assert_details_keys(
        &error,
        &[
            "delivered_events",
            "emergency_release_posted",
            "emergency_release_acknowledged",
        ],
    );
    assert_eq!(error_wire(&error)["disposition"]["retry"], "unsafe");
    assert_no_forbidden_detail_keys(&error);
}

#[test]
fn drag_pre_injection_error_wire_is_not_delivered() {
    let guard = DragReleaseGuard::new(NormalizedPoint {
        x: 1,
        y: 2,
        virtual_desktop: false,
    });
    let error = guard.enrich_error(AdapterError::internal("pre-post failure"));

    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
    assert!(
        error_wire(&error).get("details").is_none(),
        "pre-injection abort must not claim delivered_events"
    );
}

#[test]
fn chord_abort_error_wire_matches_macos_structure() {
    let mut guard = KeyReleaseGuard::new();
    guard.note_pressed(0x11);
    let error = guard.enrich_error(AdapterError::timeout("deadline"));

    assert_disposition_wire(&error, DeliverySemantics::delivered_unverified());
    assert_details_keys(
        &error,
        &[
            "delivered_events",
            "emergency_release_posted",
            "emergency_release_acknowledged",
        ],
    );
    assert_no_forbidden_detail_keys(&error);
}

#[test]
fn text_preflight_abort_wire_is_not_delivered_with_chunk_accounting() {
    let error = preflight_text("payload", Deadline::after(1).unwrap()).expect_err("deadline");

    assert_code_wire(&error, ErrorCode::Timeout);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
    assert_details_keys(
        &error,
        &[
            "delivered_chunks",
            "total_chunks",
            "required_ms",
            "remaining_ms",
        ],
    );
    assert_no_forbidden_detail_keys(&error);
}

#[test]
fn text_mid_chunk_abort_wire_is_delivered_unverified_with_chunk_accounting() {
    let deadline = Deadline::after(1).unwrap();
    std::thread::sleep(Duration::from_millis(15));
    let error = ensure_chunk_budget(deadline, 5, 2).expect_err("expired");

    assert_disposition_wire(&error, DeliverySemantics::delivered_unverified());
    assert_details_keys(&error, &["delivered_chunks", "total_chunks"]);
    assert_eq!(error_wire(&error)["disposition"]["retry"], "unsafe");
    assert_no_forbidden_detail_keys(&error);
}

const INPUT_COST_ARMS: &[&str] = &[
    "foreground_verify",
    "single_mouse_move",
    "modifier_chord",
    "text_chunk_32_units",
];

fn assert_input_cost_capture_spread(label: &str, raw: &str) {
    let value: Value = serde_json::from_str(raw).unwrap_or_else(|err| {
        panic!("{label} must parse as JSON: {err}");
    });
    assert_eq!(value["probe"], "20-input-synthesis", "{label} probe id");
    let cites = value["methodology_cites"]
        .as_array()
        .unwrap_or_else(|| panic!("{label} missing methodology_cites"));
    assert!(
        cites.iter().any(|entry| entry == "A15-13"),
        "{label} must cite A15-13"
    );
    crate::actions::envelope_parity::assert_cost_arms(label, &value, INPUT_COST_ARMS);
}

#[test]
fn a20_6_input_cost_captures_carry_min_median_max_both_environments() {
    assert_input_cost_capture_spread(
        "input-cost-devbox",
        include_str!(
            "../../../../probes/windows/20-input-synthesis/captures/input-cost-devbox.json"
        ),
    );
    assert_input_cost_capture_spread(
        "input-cost-ci",
        include_str!("../../../../probes/windows/20-input-synthesis/captures/input-cost-ci.json"),
    );
}
