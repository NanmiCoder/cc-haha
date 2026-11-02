use super::test_support::wait_args;
use super::*;
use crate::adapter::NoopAdapter;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AdapterError, ErrorCode, NotificationFilter, NotificationInfo, WindowInfo,
    adapter::WindowFilter,
};

struct NotificationErrorAdapter;

impl ObservationOps for NotificationErrorAdapter {}

impl ActionOps for NotificationErrorAdapter {}

impl InputOps for NotificationErrorAdapter {}

impl SystemOps for NotificationErrorAdapter {
    fn check_notification_support(&self, deadline: crate::Deadline) -> Result<(), AdapterError> {
        assert!(!deadline.is_expired());
        Err(AdapterError::new(
            ErrorCode::PlatformNotSupported,
            "No notification service is running in this session",
        )
        .with_details(json!({ "daemon": "absent" })))
    }

    fn list_notifications(
        &self,
        _filter: &NotificationFilter,
        _policy: crate::InteractionPolicy,
        _deadline: crate::Deadline,
        _lease: Option<&crate::InteractionLease>,
    ) -> Result<Vec<NotificationInfo>, AdapterError> {
        panic!("an unavailable notification service must refuse before reading")
    }
}

struct FlakyNotificationAdapter {
    responses: std::sync::Mutex<Vec<Result<Vec<NotificationInfo>, AdapterError>>>,
}

impl FlakyNotificationAdapter {
    fn with_responses(in_order: Vec<Result<Vec<NotificationInfo>, AdapterError>>) -> Self {
        let mut responses = in_order;
        responses.reverse();
        Self {
            responses: std::sync::Mutex::new(responses),
        }
    }
}

impl ObservationOps for FlakyNotificationAdapter {}

impl ActionOps for FlakyNotificationAdapter {}

impl InputOps for FlakyNotificationAdapter {}

impl SystemOps for FlakyNotificationAdapter {
    fn list_notifications(
        &self,
        _filter: &NotificationFilter,
        _policy: crate::InteractionPolicy,
        _deadline: crate::Deadline,
        _lease: Option<&crate::InteractionLease>,
    ) -> Result<Vec<NotificationInfo>, AdapterError> {
        self.responses
            .lock()
            .unwrap()
            .pop()
            .unwrap_or_else(|| Err(AdapterError::timeout("notification center unavailable")))
    }
}

struct LeaseState {
    active: std::sync::atomic::AtomicBool,
    acquisitions: std::sync::atomic::AtomicUsize,
    calls: std::sync::atomic::AtomicUsize,
}

struct LeaseRelease(std::sync::Arc<LeaseState>);

impl Drop for LeaseRelease {
    fn drop(&mut self) {
        self.0
            .active
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

struct LeaseTrackingNotificationAdapter {
    state: std::sync::Arc<LeaseState>,
}

impl ObservationOps for LeaseTrackingNotificationAdapter {}
impl ActionOps for LeaseTrackingNotificationAdapter {}
impl InputOps for LeaseTrackingNotificationAdapter {}

impl SystemOps for LeaseTrackingNotificationAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        assert!(
            self.state
                .active
                .compare_exchange(
                    false,
                    true,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                )
                .is_ok(),
            "a wait poll retained the previous interaction lease"
        );
        self.state
            .acquisitions
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        crate::InteractionLease::guarded(deadline, LeaseRelease(self.state.clone()))
    }

    fn list_notifications(
        &self,
        _filter: &NotificationFilter,
        policy: crate::InteractionPolicy,
        _deadline: crate::Deadline,
        lease: Option<&crate::InteractionLease>,
    ) -> Result<Vec<NotificationInfo>, AdapterError> {
        assert!(policy.is_headed());
        assert!(lease.is_some());
        assert!(self.state.active.load(std::sync::atomic::Ordering::SeqCst));
        let call = self
            .state
            .calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if call == 0 {
            Ok(vec![notification(0, "old")])
        } else {
            Ok(vec![notification(0, "old"), notification(1, "fresh")])
        }
    }
}

fn notification(index: usize, title: &str) -> NotificationInfo {
    NotificationInfo {
        index,
        app_name: "Mail".into(),
        title: title.into(),
        body: None,
        actions: vec![],
    }
}

fn notification_wait_args(timeout_ms: u64) -> WaitArgs {
    WaitArgs {
        mode: WaitModeArgs {
            surface: Some(SurfaceWait::Notification),
            ..wait_args().mode
        },
        timeout_ms,
        ..wait_args()
    }
}

struct WindowErrorAdapter;

impl ObservationOps for WindowErrorAdapter {
    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Err(AdapterError::permission_denied())
    }
}

impl ActionOps for WindowErrorAdapter {}

impl InputOps for WindowErrorAdapter {}

impl SystemOps for WindowErrorAdapter {}

#[test]
fn unavailable_notifications_refuse_before_polling_at_any_timeout() {
    for timeout_ms in [0, 150] {
        let err = execute(
            notification_wait_args(timeout_ms),
            &NotificationErrorAdapter,
            &CommandContext::default(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "PLATFORM_NOT_SUPPORTED");
        let AppError::Adapter(error) = err else {
            panic!("expected the prerequisite error")
        };
        assert_eq!(error.details.unwrap()["daemon"], "absent");
    }
}

#[test]
fn notification_wait_retries_transient_baseline_errors() {
    let adapter = FlakyNotificationAdapter::with_responses(vec![
        Err(AdapterError::timeout("notification center starting")),
        Ok(vec![notification(0, "old")]),
        Ok(vec![notification(0, "old"), notification(1, "fresh")]),
    ]);

    let value = execute(
        notification_wait_args(5_000),
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["matched"], true);
    assert_eq!(value["notification"]["title"], "fresh");
}

#[test]
fn headed_notification_wait_leases_each_poll_without_holding_across_sleep() {
    let state = std::sync::Arc::new(LeaseState {
        active: std::sync::atomic::AtomicBool::new(false),
        acquisitions: std::sync::atomic::AtomicUsize::new(0),
        calls: std::sync::atomic::AtomicUsize::new(0),
    });
    let adapter = LeaseTrackingNotificationAdapter {
        state: state.clone(),
    };

    let value = execute(
        notification_wait_args(5_000),
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert_eq!(value["notification"]["title"], "fresh");
    assert_eq!(
        state.acquisitions.load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    assert!(!state.active.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn notification_wait_fingerprint_ignores_reindexed_existing_notification() {
    let baseline = wait_notification::notification_counts(&[notification(0, "old")]);
    let current = vec![notification(4, "old")];

    assert!(wait_notification::first_new_notification(&current, &baseline).is_none());
}

#[test]
fn notification_wait_fingerprint_detects_duplicate_new_notification() {
    let baseline = wait_notification::notification_counts(&[notification(0, "same")]);
    let current = vec![notification(4, "same"), notification(5, "same")];

    let found = wait_notification::first_new_notification(&current, &baseline).unwrap();

    assert_eq!(found.index, 5);
}

#[test]
fn notification_wait_times_out_with_last_error_after_transient_failures() {
    let adapter = FlakyNotificationAdapter::with_responses(vec![]);

    let err = execute(
        notification_wait_args(600),
        &adapter,
        &CommandContext::default(),
    )
    .unwrap_err();

    let AppError::Adapter(adapter_err) = err else {
        panic!("expected adapter error");
    };
    assert_eq!(adapter_err.code, ErrorCode::Timeout);
    let details = adapter_err.details.expect("timeout should carry details");
    assert_eq!(details["last_error"]["code"], "TIMEOUT");
}

#[test]
fn expired_notification_wait_does_not_start_an_adapter_read() {
    let adapter = FlakyNotificationAdapter::with_responses(vec![Ok(Vec::new())]);

    let error = execute(
        notification_wait_args(0),
        &adapter,
        &CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(error.code(), "TIMEOUT");
    assert_eq!(adapter.responses.lock().unwrap().len(), 1);
}

#[test]
fn rejects_multiple_wait_modes() {
    let err = execute(
        WaitArgs {
            mode: WaitModeArgs {
                ms: Some(1),
                element: Some("@e1".into()),
                ..wait_args().mode
            },
            ..wait_args()
        },
        &NoopAdapter,
        &CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(err.suggestion().is_some());
}

#[test]
fn window_wait_propagates_permanent_adapter_error() {
    let err = execute(
        WaitArgs {
            mode: WaitModeArgs {
                window: Some("Document".into()),
                ..wait_args().mode
            },
            ..wait_args()
        },
        &WindowErrorAdapter,
        &CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "PERM_DENIED");
}

#[test]
fn text_wait_propagates_permanent_snapshot_error() {
    let err = execute(
        WaitArgs {
            mode: WaitModeArgs {
                text: Some("hello".into()),
                ..wait_args().mode
            },
            ..wait_args()
        },
        &WindowErrorAdapter,
        &CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "PERM_DENIED");
}

#[test]
fn app_retryability_uses_adapter_error_codes() {
    assert!(is_retryable_wait_app_error(&AppError::Adapter(
        AdapterError::timeout("busy")
    )));
    assert!(!is_retryable_wait_app_error(&AppError::Adapter(
        AdapterError::permission_denied()
    )));
    assert!(!is_retryable_wait_app_error(&AppError::Internal(
        "internal".into()
    )));
}

#[test]
fn notification_wait_allows_text_filter() {
    let result = validate_wait_mode(&WaitArgs {
        mode: WaitModeArgs {
            text: Some("done".into()),
            surface: Some(SurfaceWait::Notification),
            ..wait_args().mode
        },
        ..wait_args()
    });

    assert!(result.is_ok());
}

#[test]
fn predicate_requires_element_mode() {
    let err = validate_wait_mode(&WaitArgs {
        predicate: WaitPredicateArgs {
            predicate: Some("enabled".into()),
            ..wait_args().predicate
        },
        ..wait_args()
    })
    .unwrap_err();

    assert_eq!(err.code(), "INVALID_ARGS");
}
