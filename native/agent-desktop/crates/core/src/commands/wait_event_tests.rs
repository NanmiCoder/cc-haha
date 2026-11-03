use super::*;
use crate::SignalFilter;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::commands::wait_event_filter::process_from_baseline;
use crate::{AppInfo, WindowInfo};

pub(super) struct SequenceAdapter {
    snapshots: Vec<SignalBaseline>,
    apps: Vec<AppInfo>,
    app_calls: std::sync::Mutex<usize>,
    pub(super) calls: std::sync::Mutex<usize>,
    delay: std::time::Duration,
    remaining_at_call: std::sync::Mutex<Vec<std::time::Duration>>,
}

impl SequenceAdapter {
    pub(super) fn new(snapshots: Vec<SignalBaseline>) -> Self {
        Self {
            snapshots,
            apps: vec![app("TextEdit", "test-instance")],
            app_calls: std::sync::Mutex::new(0),
            calls: std::sync::Mutex::new(0),
            delay: std::time::Duration::ZERO,
            remaining_at_call: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn with_delay(mut self, delay: std::time::Duration) -> Self {
        self.delay = delay;
        self
    }

    fn with_apps(mut self, apps: Vec<AppInfo>) -> Self {
        self.apps = apps;
        self
    }
}

impl ObservationOps for SequenceAdapter {
    fn list_apps(&self, deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        *self.app_calls.lock().unwrap() += 1;
        if deadline.is_expired() {
            return Err(deadline.timeout_error());
        }
        Ok(self.apps.clone())
    }
}
impl ActionOps for SequenceAdapter {}
impl InputOps for SequenceAdapter {}

impl SystemOps for SequenceAdapter {
    fn capture_signal_baseline(
        &self,
        _filter: &SignalFilter,
        deadline: crate::Deadline,
    ) -> Result<SignalBaseline, AdapterError> {
        self.remaining_at_call
            .lock()
            .unwrap()
            .push(deadline.remaining());
        std::thread::sleep(self.delay);
        let mut calls = self.calls.lock().unwrap();
        let idx = (*calls).min(self.snapshots.len().saturating_sub(1));
        *calls += 1;
        Ok(self.snapshots[idx].clone())
    }
}

struct FailingInventoryAdapter {
    calls: std::sync::Mutex<usize>,
}

impl ObservationOps for FailingInventoryAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        Ok(vec![app("TextEdit", "test-instance")])
    }
}
impl ActionOps for FailingInventoryAdapter {}
impl InputOps for FailingInventoryAdapter {}

impl SystemOps for FailingInventoryAdapter {
    fn capture_signal_baseline(
        &self,
        _filter: &SignalFilter,
        _deadline: crate::Deadline,
    ) -> Result<SignalBaseline, AdapterError> {
        *self.calls.lock().unwrap() += 1;
        Err(
            AdapterError::app_unresponsive("macOS inventory").with_details(json!({
                "kind": "inventory_sources",
            })),
        )
    }
}

pub(super) fn empty_baseline() -> SignalBaseline {
    SignalBaseline {
        windows: Vec::new(),
        apps: Vec::new(),
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    }
}

pub(super) fn app(name: &str, instance: &str) -> AppInfo {
    AppInfo {
        name: name.into(),
        pid: crate::ProcessId::new(42),
        bundle_id: Some("com.example.editor".into()),
        process_instance: Some(instance.into()),
        presentation: None,
    }
}

fn baseline_with_windows(windows: Vec<WindowInfo>) -> SignalBaseline {
    SignalBaseline {
        windows,
        apps: Vec::new(),
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    }
}

fn baseline_with_apps(apps: Vec<AppInfo>) -> SignalBaseline {
    SignalBaseline {
        windows: Vec::new(),
        apps,
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    }
}

fn window(id: &str, title: &str) -> WindowInfo {
    WindowInfo {
        id: id.into(),
        title: title.into(),
        app: "TextEdit".into(),
        pid: crate::ProcessId::new(42),
        process_instance: Some("test-instance".into()),
        bounds: None,
        state: crate::WindowState {
            is_focused: true,
            ..Default::default()
        },
    }
}

pub(super) fn input(event: &str, app: Option<&str>) -> EventWaitInput {
    EventWaitInput {
        event: event.into(),
        app: app.map(str::to_string),
        window_id: None,
        window_title: None,
        timeout_ms: 5_000,
    }
}

#[test]
fn window_opened_matches_without_caller_supplied_id_or_title() {
    let adapter = SequenceAdapter::new(vec![
        empty_baseline(),
        empty_baseline(),
        baseline_with_windows(vec![window("w-99", "Untitled")]),
    ]);

    let result = wait_for_event(input("window-opened", Some("TextEdit")), &adapter, None).unwrap();

    assert_eq!(result["found"], true);
    assert_eq!(result["event"]["window_id"], "w-99");
    assert_eq!(result["event"]["title"], "Untitled");
}

#[test]
fn window_id_narrows_match_to_the_named_window() {
    let adapter = SequenceAdapter::new(vec![
        empty_baseline(),
        baseline_with_windows(vec![window("w-1", "Untitled"), window("w-2", "Untitled")]),
    ]);

    let mut request = input("window-opened", None);
    request.window_id = Some("w-2".into());
    let result = wait_for_event(request, &adapter, None).unwrap();

    assert_eq!(result["event"]["window_id"], "w-2");
}

#[test]
fn timeout_carries_wait_timeout_kind_in_details() {
    let adapter = SequenceAdapter::new(vec![empty_baseline()]);

    let mut request = input("window-opened", None);
    request.timeout_ms = 50;
    let err = wait_for_event(request, &adapter, None).unwrap_err();

    let AppError::Adapter(adapter_err) = err else {
        panic!("expected AppError::Adapter");
    };
    assert_eq!(adapter_err.code, ErrorCode::Timeout);
    let details = adapter_err.details.expect("timeout must carry details");
    assert_eq!(details["kind"], "wait_timeout");
    assert_eq!(details["predicate"], "event");
    assert_eq!(details["event"], "window-opened");
}

#[test]
fn unknown_event_value_returns_invalid_args() {
    let adapter = SequenceAdapter::new(vec![empty_baseline()]);

    let mut request = input("bogus-event", None);
    request.timeout_ms = 10;
    let err = wait_for_event(request, &adapter, None).unwrap_err();

    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn seeded_pre_action_baseline_observes_synchronous_event() {
    let current = baseline_with_windows(vec![window("w-99", "Opened during action")]);
    let adapter = SequenceAdapter::new(vec![current]);

    let result = wait_for_event(
        input("window-opened", Some("TextEdit")),
        &adapter,
        Some(Ok(empty_baseline())),
    )
    .unwrap();

    assert_eq!(result["event"]["window_id"], "w-99");
    assert_eq!(*adapter.calls.lock().unwrap(), 1);
}

#[test]
fn process_generation_change_during_poll_is_terminal() {
    let current = baseline_with_windows(vec![WindowInfo {
        process_instance: Some("new-generation".into()),
        ..window("w-new", "Reused pid")
    }]);
    let adapter = SequenceAdapter::new(vec![current]);

    let error = wait_for_event(
        input("window-opened", Some("TextEdit")),
        &adapter,
        Some(Ok(empty_baseline())),
    )
    .expect_err("a reused pid must terminate the old-generation wait");

    let AppError::Adapter(error) = error else {
        panic!("expected adapter error");
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        error.disposition.delivery(),
        crate::DeliveryDisposition::NotDelivered
    );
    assert_eq!(error.details.unwrap()["retryable"], false);
    assert_eq!(*adapter.calls.lock().unwrap(), 1);
}

#[test]
fn seeded_baseline_failure_is_not_disguised_as_timeout() {
    let adapter = SequenceAdapter::new(vec![empty_baseline()]);
    let seed_error = AdapterError::new(ErrorCode::ActionFailed, "baseline failed");

    let err = wait_for_event(
        input("window-opened", None),
        &adapter,
        Some(Err(seed_error)),
    )
    .unwrap_err();

    assert_eq!(err.code(), "ACTION_FAILED");
    assert_eq!(*adapter.calls.lock().unwrap(), 0);
}

#[test]
fn retryable_seed_inventory_failure_is_preserved_in_timeout_evidence() {
    let adapter = SequenceAdapter::new(vec![empty_baseline()]);
    let seed_error = AdapterError::app_unresponsive("macOS inventory").with_details(json!({
        "kind": "inventory_sources",
    }));
    let mut request = input("window-opened", None);
    request.timeout_ms = 20;

    let err = wait_for_event(request, &adapter, Some(Err(seed_error))).unwrap_err();

    let AppError::Adapter(adapter_err) = err else {
        panic!("expected AppError::Adapter");
    };
    let details = adapter_err.details.expect("timeout must carry evidence");
    assert_eq!(details["last_error"]["code"], "APP_UNRESPONSIVE");
    assert_eq!(
        details["last_error"]["details"]["kind"],
        "inventory_sources"
    );
    assert!(*adapter.calls.lock().unwrap() > 0);
}

#[test]
fn failed_inventory_poll_never_diffs_against_an_empty_baseline() {
    let adapter = FailingInventoryAdapter {
        calls: std::sync::Mutex::new(0),
    };
    let mut request = input("window-closed", None);
    request.timeout_ms = 20;

    let err = wait_for_event(
        request,
        &adapter,
        Some(Ok(baseline_with_windows(vec![window(
            "w-still-open",
            "Still open",
        )]))),
    )
    .unwrap_err();

    let AppError::Adapter(adapter_err) = err else {
        panic!("expected AppError::Adapter");
    };
    assert_eq!(adapter_err.code, ErrorCode::Timeout);
    let details = adapter_err.details.unwrap();
    assert_eq!(details["last_error"]["code"], "APP_UNRESPONSIVE");
    assert_eq!(details["baseline_counts"]["windows"], 1);
    assert!(*adapter.calls.lock().unwrap() > 0);
}

#[test]
fn failed_inventory_poll_never_reports_app_termination() {
    let adapter = FailingInventoryAdapter {
        calls: std::sync::Mutex::new(0),
    };
    let mut request = input("app-terminated", Some("TextEdit"));
    request.timeout_ms = 20;
    let baseline = baseline_with_apps(vec![AppInfo {
        name: "TextEdit".into(),
        pid: crate::ProcessId::new(42),
        bundle_id: Some("com.apple.TextEdit".into()),
        process_instance: Some("test-instance".into()),
        presentation: None,
    }]);

    let err = wait_for_event(request, &adapter, Some(Ok(baseline))).unwrap_err();

    let AppError::Adapter(adapter_err) = err else {
        panic!("expected AppError::Adapter");
    };
    assert_eq!(adapter_err.code, ErrorCode::Timeout);
    let details = adapter_err.details.unwrap();
    assert_eq!(details["last_error"]["code"], "APP_UNRESPONSIVE");
    assert_eq!(details["baseline_counts"]["apps"], 1);
}

#[test]
fn seeded_process_resolves_bundle_identifier() {
    let baseline = baseline_with_apps(vec![app("TextEdit", "test-instance")]);

    let process = process_from_baseline(&baseline, "com.example.editor")
        .unwrap()
        .unwrap();

    assert_eq!(process.pid, crate::ProcessId::new(42));
    assert_eq!(process.instance, "test-instance");
}

#[path = "wait_event_deadline_tests.rs"]
mod deadline_tests;

#[path = "wait_event_lifecycle_tests.rs"]
mod lifecycle_tests;

#[path = "wait_event_seen_set_tests.rs"]
mod seen_set_tests;

#[path = "wait_event_scope_tests.rs"]
mod scope_tests;

#[path = "wait_event_liveness_tests.rs"]
mod liveness_tests;
