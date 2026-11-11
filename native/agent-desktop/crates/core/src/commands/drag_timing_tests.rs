use super::*;

#[test]
fn impossible_drag_timing_is_invalid_before_target_work() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    for (duration, drop_delay, timeout) in [
        (Some(5_000), None, None),
        (Some(5_000), None, Some(5_000)),
        (Some(5_001), None, Some(5_000)),
        (Some(4_000), Some(1_000), Some(5_000)),
        (None, Some(5_000), Some(5_000)),
    ] {
        let adapter = DragCaptureAdapter::new();
        let mut args = cross_app_args(snapshot_id.clone());
        args.duration_ms = duration;
        args.drop_delay_ms = drop_delay;
        args.timeout_ms = timeout;
        let error =
            execute(args, &adapter, &CommandContext::default().with_headed(true)).unwrap_err();

        assert_eq!(error.code(), "INVALID_ARGS");
        let message = error.to_string();
        assert!(message.contains("--duration"));
        assert!(message.contains("--drop-delay"));
        assert!(message.contains("--timeout-ms"));
        let AppError::Adapter(error) = error else {
            panic!("expected adapter error");
        };
        assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
        assert_eq!(adapter.resolve_calls.load(Ordering::SeqCst), 0);
        assert!(adapter.focused_pids.lock().unwrap().is_empty());
        assert!(adapter.presented.lock().unwrap().is_empty());
        assert!(adapter.captured.lock().unwrap().is_none());
    }
}

#[test]
fn drag_timing_with_budget_headroom_still_dispatches() {
    let adapter = DragCaptureAdapter::new();
    let mut args = xy_args(Some(500));
    args.duration_ms = Some(5_000);
    args.timeout_ms = Some(10_000);
    execute(args, &adapter, &CommandContext::default().with_headed(true)).unwrap();
    let params = adapter.captured.lock().unwrap().clone().unwrap();
    assert_eq!(params.duration_ms, Some(5_000));
    assert_eq!(params.drop_delay_ms, Some(500));
}
