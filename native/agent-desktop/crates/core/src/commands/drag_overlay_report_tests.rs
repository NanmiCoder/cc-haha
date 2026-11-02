use super::*;

#[test]
fn headed_xy_drag_never_steals_focus() {
    let adapter = DragCaptureAdapter::new();

    let value = execute(
        xy_args(None),
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert!(adapter.focused_pids.lock().unwrap().is_empty());
    assert!(value.get("focused").is_none());
}

#[test]
fn an_already_satisfied_drag_report_hides_the_overlay_instead_of_claiming_a_landing() {
    let adapter = DragCaptureAdapter::new().with_drag_report(
        crate::OperationReport::satisfied_without_delivery(
            "drag",
            crate::OperationTarget::Clipboard,
        ),
    );
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    let context = CommandContext::default()
        .with_headed(true)
        .with_cursor_overlay_session("test-session", config);

    let value = execute(xy_args(None), &adapter, &context).expect("drag reports");

    assert_eq!(value["disposition"]["delivery"], "not_delivered");
    let presented = adapter.presented.lock().unwrap();
    let last = presented.last().expect("overlay control");
    assert!(last.is_hide());
    assert!(presented.iter().all(|control| {
        control
            .instruction()
            .is_none_or(|instruction| instruction.phase() != crate::CursorPhase::Effect)
    }));
}
