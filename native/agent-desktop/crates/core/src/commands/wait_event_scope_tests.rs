use super::*;

#[test]
fn app_launched_wait_spends_the_timeout_polling_instead_of_failing_fast_on_a_missing_app() {
    let adapter = SequenceAdapter::new(vec![
        empty_baseline(),
        empty_baseline(),
        baseline_with_apps(vec![app("TextEdit", "launched-generation")]),
    ])
    .with_apps(Vec::new());

    let result = wait_for_event(input("app-launched", Some("TextEdit")), &adapter, None).unwrap();

    assert_eq!(result["found"], true);
    assert_eq!(result["event"]["kind"], "app_launched");
    assert_eq!(
        *adapter.calls.lock().unwrap(),
        3,
        "must poll through the app's absence instead of returning before the loop starts"
    );
    assert_eq!(*adapter.app_calls.lock().unwrap(), 0);
}

#[test]
fn window_opened_wait_with_app_not_yet_running_defers_resolution_into_the_loop() {
    let adapter = SequenceAdapter::new(vec![
        empty_baseline(),
        empty_baseline(),
        baseline_with_windows(vec![window("w-1", "Untitled")]),
    ])
    .with_apps(Vec::new());

    let result = wait_for_event(input("window-opened", Some("TextEdit")), &adapter, None).unwrap();

    assert_eq!(result["found"], true);
    assert_eq!(result["event"]["kind"], "window_opened");
    assert_eq!(
        *adapter.calls.lock().unwrap(),
        3,
        "an unresolvable --app for an appearance-class event must not fail before the loop starts"
    );
}

#[test]
fn app_terminated_wait_reports_termination_when_the_target_is_unresolvable() {
    let adapter = SequenceAdapter::new(vec![empty_baseline()]).with_apps(Vec::new());

    let result = wait_for_event(input("app-terminated", Some("TextEdit")), &adapter, None).unwrap();

    assert_eq!(result["found"], true);
    assert_eq!(result["target_unresolved"], true);
    assert_eq!(result["event"]["kind"], "app_terminated");
    assert_eq!(result["event"]["app"], "TextEdit");
    assert_eq!(
        *adapter.calls.lock().unwrap(),
        0,
        "an unresolvable disappearance target is its own answer, no baseline capture needed"
    );
}

#[test]
fn window_closed_wait_reports_closure_when_the_target_is_unresolvable() {
    let adapter = SequenceAdapter::new(vec![empty_baseline()]).with_apps(Vec::new());

    let result = wait_for_event(input("window-closed", Some("TextEdit")), &adapter, None).unwrap();

    assert_eq!(result["found"], true);
    assert_eq!(result["event"]["kind"], "window_closed");
}

#[test]
fn a_same_identifier_sibling_appearing_mid_wait_neither_aborts_nor_supplies_the_event() {
    let target = app("TextEdit", "test-instance");
    let sibling = AppInfo {
        pid: crate::ProcessId::new(99),
        ..app("TextEdit", "sibling-instance")
    };
    let sibling_window = WindowInfo {
        pid: sibling.pid,
        process_instance: sibling.process_instance.clone(),
        state: crate::WindowState::default(),
        ..window("w-sibling", "Sibling document")
    };
    let adapter = SequenceAdapter::new(vec![
        baseline_with_apps(vec![target.clone()]),
        SignalBaseline {
            apps: vec![target.clone(), sibling.clone()],
            windows: vec![sibling_window.clone()],
            ..empty_baseline()
        },
        SignalBaseline {
            apps: vec![target, sibling],
            windows: vec![sibling_window, window("w-target", "Target document")],
            ..empty_baseline()
        },
    ]);

    let result = wait_for_event(input("window-opened", Some("TextEdit")), &adapter, None).unwrap();

    assert_eq!(result["found"], true);
    assert_eq!(result["event"]["window_id"], "w-target");
    assert_eq!(result["event"]["pid"], 42);
}

#[test]
fn app_terminated_wait_still_surfaces_a_genuine_ambiguous_resolution_error() {
    let adapter = SequenceAdapter::new(vec![empty_baseline()]).with_apps(vec![
        app("TextEdit", "generation-a"),
        app("TextEdit", "generation-b"),
    ]);

    let err =
        wait_for_event(input("app-terminated", Some("TextEdit")), &adapter, None).unwrap_err();

    assert_eq!(err.code(), "AMBIGUOUS_TARGET");
}
