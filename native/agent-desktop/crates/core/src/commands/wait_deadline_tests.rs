use super::test_support::wait_args;
use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, AppInfo, Deadline, NotificationFilter, NotificationInfo, WindowInfo};
use std::sync::atomic::{AtomicUsize, Ordering};

struct FailingRead {
    error: AdapterError,
    calls: AtomicUsize,
}

impl FailingRead {
    fn fail<T>(&self) -> Result<T, AdapterError> {
        assert_eq!(self.calls.fetch_add(1, Ordering::SeqCst), 0);
        Err(self.error.clone())
    }
}

impl ObservationOps for FailingRead {
    fn list_apps(&self, _deadline: Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        Ok(vec![AppInfo {
            name: "TestApp".into(),
            pid: crate::ProcessId::new(42),
            bundle_id: None,
            process_instance: Some("test-instance".into()),
            presentation: None,
        }])
    }

    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        self.fail()
    }
}

impl ActionOps for FailingRead {}
impl InputOps for FailingRead {}

impl SystemOps for FailingRead {
    fn list_notifications(
        &self,
        _filter: &NotificationFilter,
        _policy: crate::InteractionPolicy,
        _deadline: Deadline,
        _lease: Option<&crate::InteractionLease>,
    ) -> Result<Vec<NotificationInfo>, AdapterError> {
        self.fail()
    }

    fn wait_for_menu(
        &self,
        _process: crate::ProcessIdentity,
        _open: bool,
        _deadline: Deadline,
    ) -> Result<(), AdapterError> {
        self.fail()
    }
}

struct ResolutionFailure(AdapterError);

impl ObservationOps for ResolutionFailure {
    fn list_apps(&self, _deadline: Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        Err(self.0.clone())
    }
}

impl ActionOps for ResolutionFailure {}
impl InputOps for ResolutionFailure {}
impl SystemOps for ResolutionFailure {}

#[test]
fn menu_wait_normalizes_resolution_timeouts_and_preserves_resolution_refusals() {
    for error in [
        Deadline::after(0).unwrap().timeout_error(),
        AdapterError::permission_denied(),
    ] {
        let result = execute(
            WaitArgs {
                mode: WaitModeArgs {
                    surface: Some(SurfaceWait::Menu),
                    ..wait_args().mode
                },
                timeout_ms: 5_000,
                app: Some("TestApp".into()),
                ..wait_args()
            },
            &ResolutionFailure(error.clone()),
            &CommandContext::default(),
        )
        .unwrap_err();
        let AppError::Adapter(result) = result else {
            panic!("adapter error expected")
        };
        assert_eq!(result.code, error.code);
        assert_eq!(result.message, error.message);
        assert_eq!(result.disposition, error.disposition);
        if error.code == ErrorCode::Timeout {
            let details = result.details.unwrap();
            assert_eq!(details["kind"], "wait_timeout");
            assert_eq!(details["predicate"], "menu");
        } else {
            assert_eq!(result.details, error.details);
        }
    }
}

#[test]
fn in_flight_deadlines_end_window_text_and_notification_waits_without_retrying() {
    let modes = [
        (
            WaitModeArgs {
                window: Some("Doc".into()),
                ..wait_args().mode
            },
            "window",
        ),
        (
            WaitModeArgs {
                text: Some("hello".into()),
                ..wait_args().mode
            },
            "text",
        ),
        (
            WaitModeArgs {
                surface: Some(SurfaceWait::Notification),
                ..wait_args().mode
            },
            "notification",
        ),
    ];
    for (mode, predicate) in modes {
        let adapter = FailingRead {
            error: Deadline::after(0).unwrap().timeout_error(),
            calls: AtomicUsize::new(0),
        };
        let error = execute(
            WaitArgs {
                mode,
                timeout_ms: 5_000,
                ..wait_args()
            },
            &adapter,
            &CommandContext::default(),
        )
        .unwrap_err();
        let AppError::Adapter(error) = error else {
            panic!("adapter error expected")
        };
        let details = error.details.unwrap();
        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(details["kind"], "wait_timeout");
        assert_eq!(details["predicate"], predicate);
        assert_eq!(details["timeout_ms"], 5_000);
        assert!(details.get("last_error").is_none());
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn menu_wait_normalizes_deadlines_and_preserves_adapter_evidence_and_refusals() {
    let errors = [
        Deadline::after(0).unwrap().timeout_error(),
        AdapterError::timeout("Menu state read timed out"),
        AdapterError::timeout("Locator deadline exhausted").with_details(json!({
            "kind": "locator_deadline_exhausted", "retryable": true,
        })),
        AdapterError::timeout("No menu opened").with_details(json!({
            "kind": "wait_timeout", "predicate": "menu", "timeout_ms": 5_000,
        })),
        AdapterError::permission_denied(),
        AdapterError::app_unresponsive("TestApp").with_details(json!({"retryable": false})),
    ];
    for surface in [SurfaceWait::Menu, SurfaceWait::MenuClosed] {
        for error in &errors {
            let original = error
                .clone()
                .with_platform_detail("direction and provider evidence")
                .with_disposition(crate::DeliverySemantics::not_delivered());
            let adapter = FailingRead {
                error: original.clone(),
                calls: AtomicUsize::new(0),
            };
            let error = execute(
                WaitArgs {
                    mode: WaitModeArgs {
                        surface: Some(surface),
                        ..wait_args().mode
                    },
                    timeout_ms: 5_000,
                    app: Some("TestApp".into()),
                    ..wait_args()
                },
                &adapter,
                &CommandContext::default(),
            )
            .unwrap_err();
            let AppError::Adapter(error) = error else {
                panic!("adapter error expected")
            };
            assert_eq!(error.code, original.code);
            assert_eq!(error.message, original.message);
            assert_eq!(error.platform_detail, original.platform_detail);
            assert_eq!(error.disposition, original.disposition);
            assert_eq!(
                error.permits_retry_by_default(),
                original.permits_retry_by_default()
            );
            if original.code == ErrorCode::Timeout {
                let details = error.details.unwrap();
                assert_eq!(details["kind"], "wait_timeout");
                assert_eq!(details["predicate"], "menu");
                assert_eq!(details["timeout_ms"], 5_000);
            } else {
                assert_eq!(error.details, original.details);
            }
        }
    }
}
