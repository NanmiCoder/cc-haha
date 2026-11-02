use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, ErrorCode};

struct ProtectiveAdapter;

impl ObservationOps for ProtectiveAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<crate::AppInfo>, AdapterError> {
        Ok(vec![crate::AppInfo {
            name: "TextEdit".into(),
            pid: crate::ProcessId::new(42),
            bundle_id: Some("com.apple.TextEdit".into()),
            process_instance: Some("textedit-instance".into()),
            presentation: None,
        }])
    }
}

impl ActionOps for ProtectiveAdapter {}

impl InputOps for ProtectiveAdapter {}

impl SystemOps for ProtectiveAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn is_protected_process(&self, identifier: &str) -> bool {
        identifier.eq_ignore_ascii_case("CriticalThing")
    }

    fn close_app(
        &self,
        _app: &crate::AppInfo,
        _force: bool,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, crate::AdapterError> {
        Ok(crate::adapter::test_report())
    }
}

struct FailingAdapter;

impl ObservationOps for FailingAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<crate::AppInfo>, AdapterError> {
        Ok(vec![crate::AppInfo {
            name: "Ghost".into(),
            pid: crate::ProcessId::new(77),
            bundle_id: None,
            process_instance: Some("ghost-instance".into()),
            presentation: None,
        }])
    }
}

impl ActionOps for FailingAdapter {}

impl InputOps for FailingAdapter {}

impl SystemOps for FailingAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn close_app(
        &self,
        _app: &crate::AppInfo,
        _force: bool,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        Err(AdapterError::new(ErrorCode::AppNotFound, "no such app"))
    }
}

#[test]
fn close_app_blocks_adapter_protected_process() {
    let err = execute(
        CloseAppArgs {
            app: "CriticalThing".into(),
            force: false,
        },
        &ProtectiveAdapter,
    )
    .unwrap_err();

    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(err.to_string().contains("protected"));
    let suggestion = err
        .suggestion()
        .expect("protected-process error must carry a suggestion");
    assert!(
        suggestion.contains("session-critical"),
        "suggestion should name session-critical processes, got: {suggestion}"
    );
    for mac_name in ["loginwindow", "WindowServer", "Dock", "Finder", "launchd"] {
        assert!(
            !suggestion.contains(mac_name),
            "protected-process suggestion must not name platform-specific processes; found {mac_name} in: {suggestion}"
        );
    }
}

#[test]
fn graceful_close_reports_method_graceful_with_unverified_delivery() {
    let value = execute(
        CloseAppArgs {
            app: "TextEdit".into(),
            force: false,
        },
        &ProtectiveAdapter,
    )
    .unwrap();

    assert_eq!(value["app"], "TextEdit");
    assert_eq!(value["method"], "graceful");
    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert!(value.get("requested").is_none());
    assert!(value.get("closed").is_none());
}

#[test]
fn close_app_propagates_adapter_errors() {
    let err = execute(
        CloseAppArgs {
            app: "Ghost".into(),
            force: false,
        },
        &FailingAdapter,
    )
    .unwrap_err();

    assert_eq!(err.code(), "APP_NOT_FOUND");
}

#[test]
fn forced_close_reports_method_force_with_unverified_delivery() {
    let value = execute(
        CloseAppArgs {
            app: "TextEdit".into(),
            force: true,
        },
        &ProtectiveAdapter,
    )
    .unwrap();

    assert_eq!(value["app"], "TextEdit");
    assert_eq!(value["method"], "force");
    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert!(value.get("requested").is_none());
    assert!(value.get("closed").is_none());
}
