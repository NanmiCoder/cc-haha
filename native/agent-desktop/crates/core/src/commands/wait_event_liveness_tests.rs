use super::*;
use crate::SignalFilter;
use crate::system::process_state::ProcessState;

struct LivenessAdapter {
    snapshots: Vec<SignalBaseline>,
    calls: std::sync::Mutex<usize>,
    process_state: Result<ProcessState, ()>,
    process_state_calls: std::sync::Mutex<Vec<crate::ProcessIdentity>>,
}

impl LivenessAdapter {
    fn new(snapshots: Vec<SignalBaseline>, process_state: Result<ProcessState, ()>) -> Self {
        Self {
            snapshots,
            calls: std::sync::Mutex::new(0),
            process_state,
            process_state_calls: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl ObservationOps for LivenessAdapter {}
impl ActionOps for LivenessAdapter {}
impl InputOps for LivenessAdapter {}

impl SystemOps for LivenessAdapter {
    fn capture_signal_baseline(
        &self,
        _filter: &SignalFilter,
        _deadline: crate::Deadline,
    ) -> Result<SignalBaseline, AdapterError> {
        let mut calls = self.calls.lock().unwrap();
        let idx = (*calls).min(self.snapshots.len().saturating_sub(1));
        *calls += 1;
        Ok(self.snapshots[idx].clone())
    }

    fn process_state(
        &self,
        process: crate::ProcessIdentity,
        _deadline: crate::Deadline,
    ) -> Result<ProcessState, AdapterError> {
        self.process_state_calls.lock().unwrap().push(process);
        self.process_state
            .map_err(|()| AdapterError::not_supported("process_state"))
    }
}

fn terminating_app(pid: u32, instance: &str) -> AppInfo {
    AppInfo {
        name: "TextEdit".into(),
        pid: crate::ProcessId::new(pid),
        bundle_id: Some("com.apple.TextEdit".into()),
        process_instance: Some(instance.into()),
        presentation: None,
    }
}

#[test]
fn close_to_tray_is_suppressed_but_a_genuine_exit_still_fires() {
    let seed = baseline_with_apps(vec![terminating_app(42, "hides-into-tray")]);
    let hidden_adapter = LivenessAdapter::new(vec![empty_baseline()], Ok(ProcessState::Running));
    let mut request = input("app-terminated", None);
    request.timeout_ms = 120;

    let timeout = wait_for_event(request, &hidden_adapter, Some(Ok(seed.clone())))
        .expect_err("a process that only lost its window must not be reported as terminated");
    assert_eq!(timeout.code(), "TIMEOUT");
    assert_eq!(
        hidden_adapter.process_state_calls.lock().unwrap()[0].instance,
        "hides-into-tray",
        "the recovered identity must be the real instance, not a placeholder"
    );

    let exited_adapter = LivenessAdapter::new(
        vec![empty_baseline()],
        Ok(ProcessState::Exited { code: None }),
    );
    let result = wait_for_event(
        input("app-terminated", None),
        &exited_adapter,
        Some(Ok(seed)),
    )
    .unwrap();
    assert_eq!(result["found"], true);
    assert!(result.get("target_unresolved").is_none());
    assert_eq!(result["event"]["kind"], "app_terminated");
    assert_eq!(
        exited_adapter.process_state_calls.lock().unwrap()[0].instance,
        "hides-into-tray"
    );
}

#[test]
fn not_supported_process_state_still_reports_a_genuine_termination() {
    let seed = baseline_with_apps(vec![terminating_app(42, "unsupported-check")]);
    let adapter = LivenessAdapter::new(vec![empty_baseline()], Err(()));

    let result = wait_for_event(input("app-terminated", None), &adapter, Some(Ok(seed))).unwrap();

    assert_eq!(result["found"], true);
    assert_eq!(result["event"]["kind"], "app_terminated");
}

#[test]
fn macos_shaped_population_where_every_member_has_exited_still_reports_every_termination() {
    for (pid, instance) in [(42u32, "alpha-instance"), (77u32, "beta-instance")] {
        let seed = baseline_with_apps(vec![terminating_app(pid, instance)]);
        let adapter = LivenessAdapter::new(
            vec![empty_baseline()],
            Ok(ProcessState::Exited { code: None }),
        );

        let result =
            wait_for_event(input("app-terminated", None), &adapter, Some(Ok(seed))).unwrap();

        assert_eq!(
            result["found"], true,
            "instance {instance} must still be reported"
        );
        assert_eq!(result["event"]["kind"], "app_terminated");
        assert_eq!(
            adapter.process_state_calls.lock().unwrap()[0].instance,
            instance
        );
    }
}
