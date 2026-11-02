use super::*;
use crate::{AppInfo, DeliverySemantics, MouseButton, Point, ProcessId, WindowInfo, WindowState};

fn event(kind: MouseEventKind) -> MouseEvent {
    MouseEvent {
        kind,
        point: Point { x: 3.0, y: 4.0 },
        button: MouseButton::Left,
        modifiers: Vec::new(),
    }
}

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

#[test]
fn unverified_pointer_dispatch_names_the_event_and_claims_no_proof() {
    let report =
        OperationReport::pointer_dispatched(&event(MouseEventKind::Click { count: 1 }), false);

    assert_eq!(report.result.action, "mouse-click");
    assert_eq!(
        report.disposition(),
        DeliverySemantics::delivered_unverified()
    );
    assert_eq!(report.result.steps[0].verified(), None);
    assert!(report.result.details.is_none());
}

#[test]
fn verified_pointer_move_scopes_the_proof_to_pointer_position() {
    let report = OperationReport::pointer_dispatched(&event(MouseEventKind::Move), true);

    assert_eq!(
        report.disposition(),
        DeliverySemantics::delivered_verified()
    );
    assert_eq!(report.result.steps[0].verified(), Some(true));
    assert_eq!(
        report.result.details.unwrap()["verification_scope"],
        "pointer_position"
    );
}

#[test]
fn drag_report_carries_both_endpoints_and_stays_unverified() {
    let report = OperationReport::drag_dispatched(&DragParams {
        from: Point { x: 0.0, y: 0.0 },
        to: Point { x: 9.0, y: 9.0 },
        duration_ms: None,
        drop_delay_ms: None,
    });

    assert_eq!(
        report.disposition(),
        DeliverySemantics::delivered_unverified()
    );
    assert!(matches!(report.target, OperationTarget::Drag { .. }));
}

#[test]
fn window_operation_is_verified_only_when_the_adapter_read_back_the_state() {
    let target = OperationTarget::for_window(&window(Some("boot"))).unwrap();

    let verified = OperationReport::window_operation(
        target.clone(),
        &WindowOp::Minimize,
        Some(WindowReadback::state("window_minimized_state")),
    );
    let unverified = OperationReport::window_operation(target, &WindowOp::Maximize, None);

    assert_eq!(
        verified.disposition(),
        DeliverySemantics::delivered_verified()
    );
    assert_eq!(
        verified.result.details.unwrap()["verification_scope"],
        "window_minimized_state"
    );
    assert_eq!(
        unverified.disposition(),
        DeliverySemantics::delivered_unverified()
    );
    assert!(unverified.result.details.is_none());
}

#[test]
fn already_gone_app_is_not_delivered_with_its_evidence() {
    let app = AppInfo {
        name: "Notes".into(),
        pid: ProcessId::new(9),
        bundle_id: None,
        process_instance: Some("boot".into()),
        presentation: None,
    };
    let target = OperationTarget::for_app(&app).unwrap();

    let gone = OperationReport::app_already_gone(target.clone());
    let exited = OperationReport::app_exited(target);

    assert_eq!(gone.disposition(), DeliverySemantics::not_delivered());
    assert_eq!(
        gone.result.details.unwrap()["evidence"],
        "process_instance_not_running"
    );
    assert_eq!(
        exited.disposition(),
        DeliverySemantics::delivered_verified()
    );
}

#[test]
fn clipboard_write_is_verified_only_with_a_content_readback() {
    let verified = OperationReport::clipboard_written("clipboard-set", true);
    let unverified = OperationReport::clipboard_written("clipboard-clear", false);

    assert_eq!(
        verified.disposition(),
        DeliverySemantics::delivered_verified()
    );
    assert_eq!(
        unverified.disposition(),
        DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn target_without_a_process_instance_is_refused_before_any_dispatch() {
    let error = OperationTarget::for_window(&window(None)).unwrap_err();

    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(OperationTarget::for_window(&window(Some(""))).is_err());
}
