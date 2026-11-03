use crate::system::close::close_app_impl;
use crate::system::launch::launch_app_impl;
use crate::system::window::window_activate::{budget_exhausted, focus_window};
use agent_desktop_core::system::launch_options::LaunchOptions;
use agent_desktop_core::{
    AdapterError, AppError, AppInfo, Deadline, DeliverySemantics, ErrorCode, ErrorPayload,
    InteractionLease, ProcessId, WindowInfo, WindowState,
};
use serde_json::Value;

/// Split from this file, which sits at the per-file line cap: `shared` owns
/// the class-(a) pins - conditions both platforms can reach for the same
/// event - while this file keeps the class-(b) (platform-only) pins, the
/// fail-closed budget-exhaustion split, and the hot-path cost baseline.
#[path = "lifecycle_envelope_parity_shared_tests.rs"]
mod shared;

fn error_wire(error: &AdapterError) -> Value {
    serde_json::to_value(ErrorPayload::from_app_error(&AppError::from(error.clone())))
        .expect("ErrorPayload serializes")
}

fn assert_code_wire(error: &AdapterError, code: ErrorCode) {
    assert_eq!(error_wire(error)["code"], code.as_str());
}

fn assert_disposition_wire(error: &AdapterError, expected: DeliverySemantics) {
    let wire = error_wire(error);
    let projected = serde_json::to_value(expected).expect("disposition serializes");
    assert_eq!(wire["disposition"], projected, "disposition wire shape");
}

fn assert_class_b_envelope(error: &AdapterError, code: ErrorCode, expected: DeliverySemantics) {
    assert_code_wire(error, code);
    assert_disposition_wire(error, expected);
}

#[cfg(target_os = "windows")]
#[test]
fn class_b_windowless_close_escalation_is_action_failed_not_delivered() {
    let live = windowless_close_live_error();
    assert_class_b_envelope(
        &live,
        ErrorCode::ActionFailed,
        DeliverySemantics::not_delivered(),
    );
}

#[cfg(target_os = "windows")]
fn windowless_close_live_error() -> AdapterError {
    let (_child, pid, token) = crate::system::lifecycle_test_support::spawn_windowless_child();
    let app = AppInfo {
        name: "cmd.exe".into(),
        pid,
        bundle_id: None,
        process_instance: Some(token),
        presentation: None,
    };
    close_app_impl(&app, false, Deadline::after(5_000).expect("deadline"))
        .expect_err("windowless alive")
}

#[test]
fn class_b_create_process_invalid_name_is_invalid_args_not_delivered() {
    let error = launch_app_impl(
        r"sub\app.exe",
        &LaunchOptions::default(),
        Deadline::after(1_000).expect("deadline"),
    )
    .expect_err("relative id");
    assert_class_b_envelope(
        &error,
        ErrorCode::InvalidArgs,
        DeliverySemantics::not_delivered(),
    );
}

#[test]
fn fail_closed_higher_integrity_budget_exhaustion_is_perm_denied_not_delivered() {
    let error = budget_exhausted(true);
    assert_code_wire(&error, ErrorCode::PermDenied);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
    assert_eq!(
        error_wire(&error)["details"]["physical_delivery_started"],
        false
    );
    assert!(error.message.contains("window activation"));
}

#[test]
fn fail_closed_equal_integrity_budget_exhaustion_is_action_failed_not_started() {
    let error = budget_exhausted(false);
    assert_code_wire(&error, ErrorCode::ActionFailed);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
    assert_eq!(
        error_wire(&error)["details"]["physical_delivery_started"],
        false
    );
}

#[test]
fn stale_focus_token_is_shared_stale_ref_not_delivered() {
    let win = WindowInfo {
        id: "w-1".into(),
        title: String::new(),
        app: "fixture".into(),
        pid: ProcessId::from(1u32),
        process_instance: None,
        bounds: None,
        state: WindowState::default(),
    };
    let lease =
        InteractionLease::guarded(Deadline::after(1_000).expect("deadline"), ()).expect("lease");
    let error = focus_window(&win, &lease).expect_err("stale");
    assert_code_wire(&error, ErrorCode::StaleRef);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
}

const LIFECYCLE_COST_ARMS: &[&str] = &["launch_to_window", "close_to_exit", "window_op_round_trip"];

fn assert_lifecycle_cost_capture_spread(label: &str, raw: &str) {
    let value: Value = serde_json::from_str(raw).unwrap_or_else(|err| {
        panic!("{label} must parse as JSON: {err}");
    });
    assert_eq!(value["probe"], "21-system-lifecycle", "{label} probe id");
    let cites = value["methodology_cites"]
        .as_array()
        .unwrap_or_else(|| panic!("{label} missing methodology_cites"));
    assert!(
        cites.iter().any(|entry| entry == "A15-13"),
        "{label} must cite A15-13"
    );
    for arm in LIFECYCLE_COST_ARMS {
        let entry = value
            .get(*arm)
            .unwrap_or_else(|| panic!("{label} missing arm {arm}"));
        let min = entry["min_ms"]
            .as_f64()
            .unwrap_or_else(|| panic!("{label}/{arm} missing min_ms"));
        let median = entry["median_ms"]
            .as_f64()
            .unwrap_or_else(|| panic!("{label}/{arm} missing median_ms"));
        let max = entry["max_ms"]
            .as_f64()
            .unwrap_or_else(|| panic!("{label}/{arm} missing max_ms"));
        assert!(
            min <= median && median <= max,
            "{label}/{arm}: min<=median<=max ({min}, {median}, {max})"
        );
        assert_eq!(entry["n"], 7, "{label}/{arm} n");
        assert_eq!(
            entry["warmup_discarded"], true,
            "{label}/{arm} warmup_discarded"
        );
    }
}

#[test]
fn a20_style_lifecycle_cost_captures_carry_min_median_max_both_environments() {
    assert_lifecycle_cost_capture_spread(
        "lifecycle-cost-devbox",
        include_str!(
            "../../../../probes/windows/21-system-lifecycle/captures/lifecycle-cost-devbox.json"
        ),
    );
    assert_lifecycle_cost_capture_spread(
        "lifecycle-cost-ci",
        include_str!(
            "../../../../probes/windows/21-system-lifecycle/captures/lifecycle-cost-ci.json"
        ),
    );
}
