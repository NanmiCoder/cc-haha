use super::*;

#[test]
fn window_opened_and_closed_inside_one_wait_still_produces_window_closed() {
    let adapter = SequenceAdapter::new(vec![
        empty_baseline(),
        baseline_with_windows(vec![window("w-transient", "Transient")]),
        empty_baseline(),
    ]);

    let result = wait_for_event(input("window-closed", None), &adapter, None).unwrap();

    assert_eq!(result["found"], true);
    assert_eq!(result["event"]["kind"], "window_closed");
    assert_eq!(result["event"]["window_id"], "w-transient");
    assert_eq!(*adapter.calls.lock().unwrap(), 3);
}

#[test]
fn pre_existing_window_closed_during_a_wait_still_produces_window_closed() {
    let adapter = SequenceAdapter::new(vec![
        baseline_with_windows(vec![window("w-1", "Untitled")]),
        empty_baseline(),
    ]);

    let result = wait_for_event(input("window-closed", None), &adapter, None).unwrap();

    assert_eq!(result["found"], true);
    assert_eq!(result["event"]["kind"], "window_closed");
    assert_eq!(result["event"]["window_id"], "w-1");
}

#[test]
fn app_launched_then_terminated_inside_one_wait_produces_app_terminated_not_timeout() {
    let adapter = SequenceAdapter::new(vec![
        empty_baseline(),
        baseline_with_apps(vec![app("TextEdit", "launched-generation")]),
        empty_baseline(),
    ])
    .with_apps(Vec::new());

    let result = wait_for_event(input("app-terminated", None), &adapter, None).unwrap();

    assert_eq!(result["found"], true);
    assert_eq!(result["event"]["kind"], "app_terminated");
}

#[test]
fn window_opened_during_a_wait_still_fires_exactly_once() {
    let adapter = SequenceAdapter::new(vec![
        empty_baseline(),
        empty_baseline(),
        baseline_with_windows(vec![window("w-new", "New")]),
    ]);

    let result = wait_for_event(input("window-opened", None), &adapter, None).unwrap();

    assert_eq!(result["found"], true);
    assert_eq!(result["event"]["kind"], "window_opened");
    assert_eq!(result["event"]["window_id"], "w-new");
    assert_eq!(*adapter.calls.lock().unwrap(), 3);
}
