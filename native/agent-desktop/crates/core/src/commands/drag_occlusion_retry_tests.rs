use super::*;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

struct TransientOcclusionAdapter {
    hit_tests: AtomicU32,
    lease_acquisitions: AtomicU32,
    lease_held: Arc<AtomicBool>,
    captured: Mutex<Option<DragParams>>,
}

struct LeaseFlag(Arc<AtomicBool>);

impl Drop for LeaseFlag {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl TransientOcclusionAdapter {
    fn new() -> Self {
        Self {
            hit_tests: AtomicU32::new(0),
            lease_acquisitions: AtomicU32::new(0),
            lease_held: Arc::new(AtomicBool::new(false)),
            captured: Mutex::new(None),
        }
    }
}

impl ObservationOps for TransientOcclusionAdapter {
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
        Ok(Some(Rect {
            x: 10.0,
            y: 20.0,
            width: 40.0,
            height: 60.0,
        }))
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        if self.hit_tests.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(HitTestResult::InterceptedBy {
                role: Some("AXSheet".into()),
                name: Some("Transient sheet".into()),
                bounds: None,
            })
        } else {
            Ok(HitTestResult::ReachesTarget)
        }
    }
}

impl ActionOps for TransientOcclusionAdapter {}

impl InputOps for TransientOcclusionAdapter {
    fn drag(
        &self,
        params: DragParams,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        *self.captured.lock().unwrap() = Some(params);
        Ok(crate::adapter::test_report())
    }
}

impl SystemOps for TransientOcclusionAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        assert!(!self.lease_held.swap(true, Ordering::SeqCst));
        self.lease_acquisitions.fetch_add(1, Ordering::SeqCst);
        crate::InteractionLease::guarded(deadline, LeaseFlag(self.lease_held.clone()))
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

#[test]
fn drag_retries_transient_post_focus_occlusion_without_holding_lease() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    let adapter = TransientOcclusionAdapter::new();
    let mut args = cross_app_args(snapshot_id);
    args.timeout_ms = Some(5_000);

    let value = execute(args, &adapter, &CommandContext::default().with_headed(true)).unwrap();

    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert!(value.get("dragged").is_none());
    assert_eq!(adapter.lease_acquisitions.load(Ordering::SeqCst), 2);
    assert!(!adapter.lease_held.load(Ordering::SeqCst));
    assert!(adapter.captured.lock().unwrap().is_some());
}

#[test]
fn drag_single_shot_does_not_retry_post_focus_occlusion() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    let adapter = TransientOcclusionAdapter::new();

    let error = execute(
        cross_app_args(snapshot_id),
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();

    assert_eq!(error.code(), "ACTION_FAILED");
    assert_eq!(adapter.lease_acquisitions.load(Ordering::SeqCst), 1);
    assert!(adapter.captured.lock().unwrap().is_none());
}
