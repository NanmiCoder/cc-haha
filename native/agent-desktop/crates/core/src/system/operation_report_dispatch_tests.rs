use super::*;
use crate::{ErrorCode, ProcessId, WindowState};
use serde_json::json;

fn window(instance: Option<&str>) -> WindowInfo {
    WindowInfo {
        id: "w-1".into(),
        title: "Doc".into(),
        app: "Notes".into(),
        pid: ProcessId::new(9),
        process_instance: instance.map(str::to_owned),
        bounds: None,
        state: WindowState::default(),
    }
}

fn app(instance: Option<&str>) -> AppInfo {
    AppInfo {
        name: "Notes".into(),
        pid: ProcessId::new(9),
        bundle_id: None,
        process_instance: instance.map(str::to_owned),
        presentation: None,
    }
}

fn resize() -> WindowOp {
    WindowOp::Resize {
        width: 100.0,
        height: 80.0,
    }
}

fn after_write_timeout() -> AdapterError {
    AdapterError::timeout("deadline")
        .with_details(json!({ "phase": "wait" }))
        .with_disposition(DeliverySemantics::delivered_unverified())
}

#[test]
fn failure_after_the_write_keeps_error_identity_and_gains_target_and_steps() {
    let error = OperationReport::from_window_dispatch(
        &window(Some("boot")),
        &resize(),
        None,
        Err(after_write_timeout()),
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.unwrap();
    assert_eq!(details["phase"], "wait");
    assert_eq!(details["target"]["kind"], "window");
    assert_eq!(details["target"]["process"]["instance"], "boot");
    assert_eq!(details["steps"][0]["label"], "window_resize");
}

#[test]
fn failure_before_the_write_names_the_target_but_claims_no_step() {
    let error = OperationReport::from_window_dispatch(
        &window(Some("boot")),
        &resize(),
        None,
        Err(AdapterError::new(ErrorCode::StaleRef, "gone")
            .with_disposition(DeliverySemantics::not_delivered())),
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::StaleRef);
    let details = error.details.unwrap();
    assert!(details.get("target").is_some());
    assert!(details.get("steps").is_none());
}

#[test]
fn missing_instance_keeps_the_platform_error_unchanged() {
    let error = OperationReport::from_window_dispatch(
        &window(None),
        &resize(),
        None,
        Err(AdapterError::new(ErrorCode::StaleRef, "needs instance")
            .with_disposition(DeliverySemantics::not_delivered())),
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert!(error.details.is_none());
}

#[test]
fn missing_instance_after_success_still_reports_the_completed_operation() {
    let report = OperationReport::from_window_dispatch(
        &window(None),
        &WindowOp::Minimize,
        Some(WindowReadback::state("window_minimized_state")),
        Ok(()),
    )
    .unwrap();

    assert_eq!(
        report.disposition(),
        DeliverySemantics::delivered_verified()
    );
    let details = report.result.details.unwrap();
    assert_eq!(details["target_identity"], "process_instance_unavailable");
    assert_eq!(details["verification_scope"], "window_minimized_state");
}

#[test]
fn close_failure_after_the_request_keeps_target_and_request_step() {
    let error =
        OperationReport::from_close_dispatch(&app(Some("boot")), Err(after_write_timeout()))
            .unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
    let details = error.details.unwrap();
    assert_eq!(details["target"]["kind"], "app");
    assert_eq!(details["steps"][0]["label"], "terminate_request");
}

#[test]
fn close_without_instance_after_success_is_still_a_report() {
    let exited = OperationReport::from_close_dispatch(&app(None), Ok(true)).unwrap();
    let gone = OperationReport::from_close_dispatch(&app(None), Ok(false)).unwrap();

    assert_eq!(
        exited.disposition(),
        DeliverySemantics::delivered_verified()
    );
    assert_eq!(gone.disposition(), DeliverySemantics::not_delivered());
    assert_eq!(
        gone.result.details.unwrap()["target_identity"],
        "process_instance_unavailable"
    );
}

#[test]
fn geometry_readback_states_tolerance_and_units() {
    let report = OperationReport::window_operation(
        OperationTarget::for_window(&window(Some("boot"))).unwrap(),
        &resize(),
        Some(WindowReadback::geometry("window_size", 8.0, "px")),
    );

    let details = report.result.details.unwrap();
    assert_eq!(details["verification_scope"], "window_size");
    assert_eq!(details["tolerance"], 8.0);
    assert_eq!(details["units"], "px");
}
