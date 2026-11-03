use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use std::{sync::Mutex, time::Duration};

struct ProbeBudgetAdapter {
    probe_budget: Mutex<Option<Duration>>,
}

impl ObservationOps for ProbeBudgetAdapter {}
impl ActionOps for ProbeBudgetAdapter {}
impl InputOps for ProbeBudgetAdapter {}

impl SystemOps for ProbeBudgetAdapter {
    fn process_state(
        &self,
        _process: crate::ProcessIdentity,
        deadline: Deadline,
    ) -> Result<ProcessState, AdapterError> {
        *self.probe_budget.lock().unwrap() = Some(deadline.remaining());
        Ok(ProcessState::Running)
    }
}

#[test]
fn stopped_app_probe_never_outlives_the_command_deadline() {
    let adapter = ProbeBudgetAdapter {
        probe_budget: Mutex::new(None),
    };
    let app = crate::AppInfo {
        name: "Example".into(),
        pid: crate::ProcessId::new(42),
        bundle_id: None,
        process_instance: Some("test-instance".into()),
        presentation: None,
    };
    let deadline = Deadline::detached_after(200).unwrap();

    let _ = missing_window_error("w-1", Some(&app), &adapter, deadline);

    let budget = adapter.probe_budget.lock().unwrap().expect("probe ran");
    assert!(budget <= Duration::from_millis(200), "{budget:?}");
}
