use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::commands::{
    clipboard_clear, close_app::CloseAppArgs, mouse_move::MouseMoveArgs,
    move_window::MoveWindowArgs,
};
use crate::context::CommandContext;
use crate::{
    ActionResult, AdapterError, AppInfo, Deadline, InteractionLease, MouseEvent, OperationReport,
    OperationTarget, Point, ProcessIdentity, WindowInfo, WindowOp,
};
use serde_json::Value;

struct ReportingAdapter {
    report: OperationReport,
}

fn window() -> WindowInfo {
    WindowInfo {
        id: "w-1".into(),
        title: "Notes".into(),
        app: "Notes".into(),
        pid: crate::ProcessId::new(42),
        process_instance: Some("boot-1".into()),
        bounds: None,
        state: crate::WindowState {
            visible: Some(true),
            ..Default::default()
        },
    }
}

impl ObservationOps for ReportingAdapter {
    fn list_apps(&self, _deadline: Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        Ok(vec![AppInfo {
            name: "Notes".into(),
            pid: crate::ProcessId::new(42),
            bundle_id: None,
            process_instance: Some("boot-1".into()),
            presentation: None,
        }])
    }

    fn list_windows(
        &self,
        _filter: &crate::adapter::WindowFilter,
        _deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![window()])
    }
}

impl ActionOps for ReportingAdapter {}

impl InputOps for ReportingAdapter {
    fn mouse_event(
        &self,
        _event: MouseEvent,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Ok(self.report.clone())
    }

    fn clear_clipboard(&self, _lease: &InteractionLease) -> Result<OperationReport, AdapterError> {
        Ok(self.report.clone())
    }
}

impl SystemOps for ReportingAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn resolve_window_strict(
        &self,
        win: &WindowInfo,
        _deadline: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        Ok(win.clone())
    }

    fn close_app(
        &self,
        _app: &AppInfo,
        _force: bool,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Ok(self.report.clone())
    }

    fn window_op(
        &self,
        _win: &WindowInfo,
        _op: WindowOp,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Ok(self.report.clone())
    }
}

fn app_target() -> OperationTarget {
    OperationTarget::App {
        name: "Notes".into(),
        process: ProcessIdentity::new(42u32, "boot-1"),
    }
}

fn assert_no_flags(value: &Value, flags: &[&str]) {
    for flag in flags {
        assert!(value.get(*flag).is_none(), "{flag} must not be claimed");
    }
}

#[test]
fn close_of_an_already_gone_app_reports_not_delivered_without_a_closed_claim() {
    let adapter = ReportingAdapter {
        report: OperationReport::satisfied_without_delivery("close-app", app_target()),
    };

    let value = crate::commands::close_app::execute(
        CloseAppArgs {
            app: "Notes".into(),
            force: false,
        },
        &adapter,
    )
    .unwrap();

    assert_eq!(value["disposition"]["delivery"], "not_delivered");
    assert_eq!(value["disposition"]["retry"], "safe");
    assert_eq!(value["target"]["kind"], "app");
    assert_eq!(value["method"], "graceful");
    assert_no_flags(&value, &["closed", "requested"]);
}

#[test]
fn verified_window_move_reports_the_adapter_target_not_a_success_flag() {
    let target = OperationTarget::Window {
        id: "w-1".into(),
        title: "Notes".into(),
        process: ProcessIdentity::new(42u32, "boot-1"),
    };
    let adapter = ReportingAdapter {
        report: OperationReport::new(
            ActionResult::delivered_unverified("move-window").with_verified_delivery(),
            target,
        ),
    };

    let value = crate::commands::move_window::execute(
        MoveWindowArgs {
            app: Some("Notes".into()),
            window_id: None,
            x: 10.0,
            y: 20.0,
        },
        &adapter,
    )
    .unwrap();

    assert_eq!(value["disposition"]["delivery"], "delivered_verified");
    assert_eq!(value["target"]["process"]["instance"], "boot-1");
    assert_eq!(value["x"], 10.0);
    assert_no_flags(&value, &["moved"]);
}

#[test]
fn clipboard_clear_reports_the_adapter_disposition() {
    let adapter = ReportingAdapter {
        report: OperationReport::delivered_unverified(
            "clipboard-clear",
            OperationTarget::Clipboard,
        ),
    };

    let value = clipboard_clear::execute(&adapter).unwrap();

    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert_eq!(value["target"]["kind"], "clipboard");
    assert_no_flags(&value, &["cleared", "ok"]);
}

#[test]
fn mouse_move_reports_pointer_target_and_request_coordinates() {
    let adapter = ReportingAdapter {
        report: OperationReport::new(
            ActionResult::delivered_unverified("mouse-move").with_verified_delivery(),
            OperationTarget::Pointer {
                point: Point { x: 5.0, y: 6.0 },
            },
        ),
    };

    let value = crate::commands::mouse_move::execute(
        MouseMoveArgs { x: 5.0, y: 6.0 },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert_eq!(value["disposition"]["delivery"], "delivered_verified");
    assert_eq!(value["target"]["kind"], "pointer");
    assert_eq!(value["y"], 6.0);
    assert_no_flags(&value, &["moved"]);
}
