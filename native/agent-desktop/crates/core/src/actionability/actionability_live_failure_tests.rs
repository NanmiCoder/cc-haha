use super::*;

#[test]
fn offscreen_refusal_does_not_claim_movement_from_one_live_sample() {
    let mut snapshot = entry();
    snapshot.geometry.bounds = Some(Rect {
        x: -184.0,
        y: 512.0,
        width: 90.0,
        height: 44.0,
    });
    snapshot.geometry.bounds_hash = snapshot.geometry.bounds.unwrap().bounds_hash();
    let adapter = LiveAdapter {
        state: Some(ElementState {
            role: "button".into(),
            states: vec![],
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(true),
        }),
        bounds: Some(Rect {
            x: -183.0,
            ..snapshot.geometry.bounds.unwrap()
        }),
        actions: Some(vec![]),
    };
    let error = check_live(
        &snapshot,
        &NativeHandle::null(),
        &adapter,
        &ActionRequest::headed(Action::Click),
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    assert!(error.message.contains("live offscreen state is true"));
    assert!(!error.message.contains("bounds changed"));
    let details = error.details.unwrap();
    let checks = details["checks"].as_array().unwrap();
    let stability = checks
        .iter()
        .find(|check| check["check"] == "stable")
        .unwrap();
    assert_eq!(stability["status"], "unknown");
    assert_eq!(stability["stability"]["samples"], 1);
    assert_eq!(stability["stability"]["span_ms"], 0);
    assert_eq!(
        stability["reason"],
        "live bounds stability has not been sampled"
    );
}

#[test]
fn empty_live_actions_replace_stale_snapshot_capabilities() {
    let stale = entry();
    let adapter = LiveAdapter {
        state: None,
        bounds: stale.geometry.bounds,
        actions: Some(vec![]),
    };

    let err = check_live(
        &stale,
        &NativeHandle::null(),
        &adapter,
        &ActionRequest::headless(Action::Click),
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::PolicyDenied);
    assert!(err.message.contains("supported_action"));
}

#[test]
fn unsupported_live_reads_fail_closed() {
    let err = check_live(
        &entry(),
        &NativeHandle::null(),
        &UnsupportedLiveAdapter,
        &ActionRequest::headless(Action::Click),
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::ActionNotSupported);
    assert!(err.message.contains("Live element evidence"));
}

#[test]
fn empty_live_element_fails_as_stale_before_dispatch() {
    let err = check_live(
        &entry(),
        &NativeHandle::null(),
        &DeadLiveElementAdapter,
        &ActionRequest::headless(Action::Click),
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::StaleRef);
    assert!(err.message.contains("changed role"));
}

#[test]
fn live_read_errors_are_not_silently_downgraded_to_snapshot_data() {
    let err = check_live(
        &entry(),
        &NativeHandle::null(),
        &LiveReadErrorAdapter,
        &ActionRequest::headless(Action::Click),
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::PermDenied);
    assert_eq!(err.disposition, crate::DeliverySemantics::not_delivered());
}

#[test]
fn transient_live_read_failure_reports_no_delivery() {
    struct FailedRead(crate::DeliverySemantics);
    impl ObservationOps for FailedRead {
        fn get_live_element(
            &self,
            _: &NativeHandle,
            _: crate::Deadline,
        ) -> Result<LiveElement, AdapterError> {
            Err(
                AdapterError::new(ErrorCode::AppUnresponsive, "incomplete live evidence")
                    .with_disposition(self.0),
            )
        }
    }
    impl ActionOps for FailedRead {}
    impl InputOps for FailedRead {}
    impl SystemOps for FailedRead {}

    for (reported, expected) in [
        (
            crate::DeliverySemantics::unknown(),
            crate::DeliverySemantics::not_delivered(),
        ),
        (
            crate::DeliverySemantics::uncertain(),
            crate::DeliverySemantics::uncertain(),
        ),
    ] {
        let error = check_live(
            &entry(),
            &NativeHandle::null(),
            &FailedRead(reported),
            &ActionRequest::headless(Action::Click),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert_eq!(error.disposition, expected);
    }
}
