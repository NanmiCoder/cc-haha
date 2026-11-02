use super::*;
use crate::AdapterError;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};

struct MenuWaitAdapter {
    open_seen: std::sync::Mutex<Option<bool>>,
}

impl ObservationOps for MenuWaitAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<crate::AppInfo>, AdapterError> {
        Ok(vec![crate::AppInfo {
            name: "MenuApp".into(),
            pid: crate::ProcessId::new(42),
            bundle_id: None,
            process_instance: Some("test-instance".into()),
            presentation: None,
        }])
    }
}

impl ActionOps for MenuWaitAdapter {}

impl InputOps for MenuWaitAdapter {}

impl SystemOps for MenuWaitAdapter {
    fn wait_for_menu(
        &self,
        process: crate::ProcessIdentity,
        open: bool,
        _deadline: crate::Deadline,
    ) -> Result<(), AdapterError> {
        assert_eq!(process.pid, 42);
        assert_eq!(process.instance, "test-instance");
        *self.open_seen.lock().unwrap() = Some(open);
        Ok(())
    }
}

#[test]
fn menu_closed_wait_requests_closed_state_and_reports_found() {
    use super::test_support::wait_args;
    let adapter = MenuWaitAdapter {
        open_seen: std::sync::Mutex::new(None),
    };
    let value = execute(
        WaitArgs {
            mode: WaitModeArgs {
                surface: Some(SurfaceWait::MenuClosed),
                ..wait_args().mode
            },
            app: Some("MenuApp".into()),
            ..wait_args()
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["found"], true);
    assert_eq!(
        *adapter.open_seen.lock().unwrap(),
        Some(false),
        "--menu-closed must wait for the menu to be closed (open=false)"
    );
}

struct ExitedMenuAdapter;

impl ObservationOps for ExitedMenuAdapter {
    fn list_apps(&self, deadline: crate::Deadline) -> Result<Vec<crate::AppInfo>, AdapterError> {
        MenuWaitAdapter {
            open_seen: std::sync::Mutex::new(None),
        }
        .list_apps(deadline)
    }
}

impl ActionOps for ExitedMenuAdapter {}

impl InputOps for ExitedMenuAdapter {}

impl SystemOps for ExitedMenuAdapter {
    fn wait_for_menu(
        &self,
        _process: crate::ProcessIdentity,
        _open: bool,
        _deadline: crate::Deadline,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::stale_ref_because(
            "target process identity changed",
        ))
    }

    fn process_state(
        &self,
        _process: crate::ProcessIdentity,
        _deadline: crate::Deadline,
    ) -> Result<crate::system::process_state::ProcessState, AdapterError> {
        Ok(crate::system::process_state::ProcessState::Exited { code: None })
    }
}

#[test]
fn menu_wait_on_an_exited_process_recovers_by_inspecting_not_by_snapshot() {
    use super::test_support::wait_args;
    let error = execute(
        WaitArgs {
            mode: WaitModeArgs {
                surface: Some(SurfaceWait::Menu),
                ..wait_args().mode
            },
            app: Some("MenuApp".into()),
            ..wait_args()
        },
        &ExitedMenuAdapter,
        &CommandContext::default(),
    )
    .unwrap_err();

    let payload = crate::response::output::ErrorPayload::from_app_error(&error);
    assert_eq!(payload.code, "STALE_REF");
    let recovery = payload.recovery.expect("exited process carries recovery");
    assert_eq!(recovery.strategy, "inspect_state_then_retry_original");
    assert!(payload.suggestion.unwrap().contains("exited"));
}

struct BudgetProbeAdapter {
    probe_budget: std::sync::Mutex<Option<std::time::Duration>>,
}

impl ObservationOps for BudgetProbeAdapter {
    fn list_apps(&self, deadline: crate::Deadline) -> Result<Vec<crate::AppInfo>, AdapterError> {
        ExitedMenuAdapter.list_apps(deadline)
    }
}

impl ActionOps for BudgetProbeAdapter {}

impl InputOps for BudgetProbeAdapter {}

impl SystemOps for BudgetProbeAdapter {
    fn wait_for_menu(
        &self,
        process: crate::ProcessIdentity,
        open: bool,
        deadline: crate::Deadline,
    ) -> Result<(), AdapterError> {
        ExitedMenuAdapter.wait_for_menu(process, open, deadline)
    }

    fn process_state(
        &self,
        _process: crate::ProcessIdentity,
        deadline: crate::Deadline,
    ) -> Result<crate::system::process_state::ProcessState, AdapterError> {
        *self.probe_budget.lock().unwrap() = Some(deadline.remaining());
        Ok(crate::system::process_state::ProcessState::Running)
    }
}

#[test]
fn exited_process_probe_never_outlives_the_wait_deadline() {
    use super::test_support::wait_args;
    let adapter = BudgetProbeAdapter {
        probe_budget: std::sync::Mutex::new(None),
    };
    let _ = execute(
        WaitArgs {
            mode: WaitModeArgs {
                surface: Some(SurfaceWait::Menu),
                ..wait_args().mode
            },
            app: Some("MenuApp".into()),
            timeout_ms: 300,
            ..wait_args()
        },
        &adapter,
        &CommandContext::default(),
    );

    let budget = adapter.probe_budget.lock().unwrap().expect("probe ran");
    assert!(
        budget <= std::time::Duration::from_millis(300),
        "{budget:?}"
    );
}
