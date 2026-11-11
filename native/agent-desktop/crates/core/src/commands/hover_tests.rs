use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AdapterError, Rect,
    actions::capability,
    adapter::NativeHandle,
    adapter::hit_test::HitTestResult,
    commands::stale_retry_test_support::StaleRetryCounter,
    refs::refs_store::RefStore,
    refs::refs_test_support::HomeGuard,
    refs::{RefEntry, RefMap},
};
use std::sync::{
    Mutex,
    atomic::{AtomicU32, Ordering},
};

struct HoverCaptureAdapter {
    moved_to: Mutex<Option<MouseEvent>>,
    focused_pids: Mutex<Vec<crate::ProcessId>>,
    focused_bounds: Option<Rect>,
    refuses_receiver: bool,
    receiver_checks: AtomicU32,
}

impl HoverCaptureAdapter {
    fn new() -> Self {
        Self {
            moved_to: Mutex::new(None),
            focused_pids: Mutex::new(Vec::new()),
            focused_bounds: None,
            refuses_receiver: false,
            receiver_checks: AtomicU32::new(0),
        }
    }

    fn refusing_receiver(mut self) -> Self {
        self.refuses_receiver = true;
        self
    }

    fn with_focused_bounds(mut self, bounds: Rect) -> Self {
        self.focused_bounds = Some(bounds);
        self
    }
}

impl ObservationOps for HoverCaptureAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        if !self.focused_pids.lock().unwrap().is_empty()
            && let Some(bounds) = self.focused_bounds
        {
            return Ok(Some(bounds));
        }
        Ok(Some(Rect {
            x: 100.0,
            y: 200.0,
            width: 20.0,
            height: 10.0,
        }))
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        Ok(HitTestResult::ReachesTarget)
    }

    fn confirm_pointer_receiver(
        &self,
        _entry: &RefEntry,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<(), AdapterError> {
        self.receiver_checks.fetch_add(1, Ordering::SeqCst);
        if self.refuses_receiver {
            return Err(AdapterError::new(
                crate::ErrorCode::ActionFailed,
                "Another element intercepts the pointer target",
            )
            .with_details(json!({ "check": "receives_events" }))
            .with_disposition(crate::DeliverySemantics::not_delivered()));
        }
        Ok(())
    }
}

impl ActionOps for HoverCaptureAdapter {}

impl InputOps for HoverCaptureAdapter {
    fn mouse_event(
        &self,
        event: MouseEvent,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        *self.moved_to.lock().unwrap() = Some(event);
        Ok(crate::adapter::test_report())
    }
}

impl SystemOps for HoverCaptureAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn resolve_window_strict(
        &self,
        window: &crate::WindowInfo,
        _deadline: crate::Deadline,
    ) -> Result<crate::WindowInfo, AdapterError> {
        Ok(window.clone())
    }

    fn focus_window(
        &self,
        window: &crate::WindowInfo,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        self.focused_pids.lock().unwrap().push(window.pid);
        Ok(())
    }
}

fn ref_snapshot(pid: u32) -> String {
    let store = RefStore::new().unwrap();
    let mut refmap = RefMap::new();
    refmap.allocate(RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(pid),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some("Target".into()),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash: None,
        },
        capabilities: crate::RefCapabilities {
            states: vec![],
            available_actions: vec![capability::CLICK.into()],
        },
        source: crate::RefSource {
            source_app: Some(format!("App {pid}")),
            source_window_id: Some(format!("w-{pid}")),
            source_window_title: Some(format!("Window {pid}")),
            source_window_bounds_hash: None,
            source_surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    });
    store.save_new_snapshot(&refmap).unwrap()
}

fn ref_args(snapshot_id: String) -> HoverArgs {
    HoverArgs {
        ref_id: Some(format!("@{}:e1", snapshot_id)),
        xy: None,
        duration_ms: None,
        timeout_ms: None,
    }
}

#[test]
fn headless_ref_hover_is_policy_denied_before_cursor_move() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = HoverCaptureAdapter::new();

    let err = execute(ref_args(snapshot_id), &adapter, &CommandContext::default()).unwrap_err();

    assert_eq!(err.code(), "POLICY_DENIED");
    assert!(adapter.focused_pids.lock().unwrap().is_empty());
    assert!(adapter.moved_to.lock().unwrap().is_none());
}

#[test]
fn headed_ref_hover_focuses_target_app_once() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = HoverCaptureAdapter::new();

    let value = execute(
        ref_args(snapshot_id),
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert_eq!(*adapter.focused_pids.lock().unwrap(), vec![42]);
    assert_eq!(value["focused"], true);
    assert_eq!(value["x"], 110.0);
    assert_eq!(value["y"], 205.0);
}

#[test]
fn positive_timeout_uses_stable_post_focus_hover_bounds() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = HoverCaptureAdapter::new().with_focused_bounds(Rect {
        x: 300.0,
        y: 400.0,
        width: 20.0,
        height: 10.0,
    });
    let mut args = ref_args(snapshot_id);
    args.timeout_ms = Some(5_000);

    let value = execute(args, &adapter, &CommandContext::default().with_headed(true)).unwrap();

    assert_eq!(*adapter.focused_pids.lock().unwrap(), vec![42]);
    assert_eq!(value["x"], 310.0);
    assert_eq!(value["y"], 405.0);
}

#[test]
fn headed_xy_hover_never_steals_focus() {
    let adapter = HoverCaptureAdapter::new();

    let value = execute(
        HoverArgs {
            ref_id: None,
            xy: Some((5.0, 6.0)),
            duration_ms: None,
            timeout_ms: None,
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert!(adapter.focused_pids.lock().unwrap().is_empty());
    assert!(value.get("focused").is_none());
}

struct StaleThenOkAdapter {
    retry: StaleRetryCounter,
    minimum_resolves_before_lease: u32,
    lease_acquisitions: AtomicU32,
}

impl StaleThenOkAdapter {
    fn new(fail_until: u32) -> Self {
        Self {
            retry: StaleRetryCounter::new(fail_until),
            minimum_resolves_before_lease: 0,
            lease_acquisitions: AtomicU32::new(0),
        }
    }

    fn expect_poll_before_lease(mut self, minimum: u32) -> Self {
        self.minimum_resolves_before_lease = minimum;
        self
    }
}

impl ObservationOps for StaleThenOkAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.retry.attempt()
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Ok(Some(Rect {
            x: 100.0,
            y: 200.0,
            width: 20.0,
            height: 10.0,
        }))
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        Ok(HitTestResult::ReachesTarget)
    }
}

impl ActionOps for StaleThenOkAdapter {}

impl InputOps for StaleThenOkAdapter {
    fn mouse_event(
        &self,
        _event: MouseEvent,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        Ok(crate::adapter::test_report())
    }
}

impl SystemOps for StaleThenOkAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        assert!(self.retry.calls() >= self.minimum_resolves_before_lease);
        self.lease_acquisitions.fetch_add(1, Ordering::SeqCst);
        crate::InteractionLease::guarded(deadline, ())
    }

    fn resolve_window_strict(
        &self,
        window: &crate::WindowInfo,
        _deadline: crate::Deadline,
    ) -> Result<crate::WindowInfo, AdapterError> {
        Ok(window.clone())
    }

    fn focus_window(
        &self,
        _window: &crate::WindowInfo,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        Ok(())
    }
}

/// Regression for the F2 fix: `hover --ref` previously had no `--timeout-ms`
/// at all, so a transient `STALE_REF` on the resolved ref failed the command
/// outright. This proves the wired budget retries through the real
/// `hover::execute` path.
#[test]
fn transient_stale_ref_retries_then_succeeds_when_timeout_wired() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = StaleThenOkAdapter::new(2).expect_poll_before_lease(3);

    let value = execute(
        HoverArgs {
            ref_id: Some(format!("@{}:e1", snapshot_id)),
            xy: None,
            duration_ms: None,
            timeout_ms: Some(5_000),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert!(value.get("hovered").is_none());
    assert!(adapter.retry.calls() >= 3);
    assert_eq!(adapter.lease_acquisitions.load(Ordering::SeqCst), 1);
}

#[path = "hover_receiver_tests.rs"]
mod receiver_tests;

#[path = "hover_preflight_tests.rs"]
mod preflight_tests;
