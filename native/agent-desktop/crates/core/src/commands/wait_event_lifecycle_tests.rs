use super::*;

#[test]
fn named_app_launch_wait_observes_absent_to_present_without_resolution() {
    let adapter = SequenceAdapter::new(vec![
        empty_baseline(),
        baseline_with_apps(vec![app("TextEdit", "launched-generation")]),
    ])
    .with_apps(Vec::new());

    let result = wait_for_event(input("app-launched", Some("TextEdit")), &adapter, None).unwrap();

    assert_eq!(result["event"]["kind"], "app_launched");
    assert_eq!(*adapter.app_calls.lock().unwrap(), 0);
}

#[test]
fn seeded_app_launch_wait_remains_name_scoped_across_generations() {
    let existing = app("TextEdit", "existing-generation");
    let launched = app("TextEdit", "launched-generation");
    let adapter = SequenceAdapter::new(vec![baseline_with_apps(vec![existing.clone(), launched])]);
    let seeded = baseline_with_apps(vec![existing]);

    let result = wait_for_event(
        input("app-launched", Some("TextEdit")),
        &adapter,
        Some(Ok(seeded)),
    )
    .unwrap();

    assert_eq!(result["event"]["kind"], "app_launched");
    assert_eq!(*adapter.app_calls.lock().unwrap(), 0);
}

#[test]
fn seeded_app_termination_uses_pre_action_identity_after_process_exit() {
    let adapter = SequenceAdapter::new(vec![empty_baseline()]).with_apps(Vec::new());
    let seeded = baseline_with_apps(vec![app("TextEdit", "terminated-generation")]);

    let result = wait_for_event(
        input("app-terminated", Some("TextEdit")),
        &adapter,
        Some(Ok(seeded)),
    )
    .unwrap();

    assert_eq!(result["event"]["kind"], "app_terminated");
    assert_eq!(*adapter.app_calls.lock().unwrap(), 0);
}

#[test]
fn seeded_process_generation_change_is_rejected_during_polling() {
    let adapter = SequenceAdapter::new(vec![baseline_with_apps(vec![app(
        "TextEdit",
        "new-generation",
    )])]);
    let seeded = baseline_with_apps(vec![app("TextEdit", "old-generation")]);

    let error = wait_for_event(
        input("app-terminated", Some("TextEdit")),
        &adapter,
        Some(Ok(seeded)),
    )
    .expect_err("a reused process identity must terminate the seeded wait");

    let AppError::Adapter(error) = error else {
        panic!("expected adapter error");
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        error.disposition.delivery(),
        crate::DeliveryDisposition::NotDelivered
    );
    assert_eq!(error.details.unwrap()["kind"], "process_changed");
    assert_eq!(*adapter.calls.lock().unwrap(), 1);
}
