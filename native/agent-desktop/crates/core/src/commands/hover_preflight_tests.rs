use super::*;

struct OccludedTargetAdapter {
    moved_to: Mutex<Option<MouseEvent>>,
    occlusions_before_success: usize,
    hit_tests: std::sync::atomic::AtomicUsize,
    lease_acquisitions: std::sync::atomic::AtomicUsize,
    lease_held: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

struct LeaseFlag(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Drop for LeaseFlag {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

impl ObservationOps for OccludedTargetAdapter {
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
        let attempt = self
            .hit_tests
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if attempt >= self.occlusions_before_success {
            return Ok(HitTestResult::ReachesTarget);
        }
        Ok(HitTestResult::InterceptedBy {
            role: Some("AXSheet".into()),
            name: Some("Save changes?".into()),
            bounds: None,
        })
    }
}

impl ActionOps for OccludedTargetAdapter {}

impl InputOps for OccludedTargetAdapter {
    fn mouse_event(
        &self,
        event: MouseEvent,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        *self.moved_to.lock().unwrap() = Some(event);
        Ok(crate::adapter::test_report())
    }
}

impl SystemOps for OccludedTargetAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        assert!(
            !self
                .lease_held
                .swap(true, std::sync::atomic::Ordering::SeqCst)
        );
        self.lease_acquisitions
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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

/// F27 regression: `hover --ref` previously resolved the ref's bounds to a
/// point and dispatched the mouse move without ever consulting `hit_test`,
/// so an occluded target (e.g. a modal sheet over it) was hovered blind.
/// This proves the preflight now fails before any mouse event is sent.
#[test]
fn hover_on_occluded_ref_fails_preflight_before_dispatch() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = OccludedTargetAdapter {
        moved_to: Mutex::new(None),
        occlusions_before_success: usize::MAX,
        hit_tests: std::sync::atomic::AtomicUsize::new(0),
        lease_acquisitions: std::sync::atomic::AtomicUsize::new(0),
        lease_held: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };

    let err = execute(
        ref_args(snapshot_id),
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();

    assert_eq!(err.code(), "ACTION_FAILED");
    let AppError::Adapter(adapter_error) = &err else {
        panic!("expected adapter actionability failure")
    };
    assert!(
        adapter_error
            .details
            .as_ref()
            .is_some_and(|details| details.to_string().contains("AXSheet"))
    );
    assert!(adapter.moved_to.lock().unwrap().is_none());
    assert_eq!(
        adapter.hit_tests.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(
        adapter
            .lease_acquisitions
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

#[test]
fn headed_hover_retries_transient_post_focus_occlusion_without_holding_lease() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = OccludedTargetAdapter {
        moved_to: Mutex::new(None),
        occlusions_before_success: 1,
        hit_tests: std::sync::atomic::AtomicUsize::new(0),
        lease_acquisitions: std::sync::atomic::AtomicUsize::new(0),
        lease_held: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let mut args = ref_args(snapshot_id);
    args.timeout_ms = Some(5_000);

    let value = execute(args, &adapter, &CommandContext::default().with_headed(true)).unwrap();

    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert!(value.get("hovered").is_none());
    assert_eq!(
        adapter.hit_tests.load(std::sync::atomic::Ordering::SeqCst),
        3
    );
    assert_eq!(
        adapter
            .lease_acquisitions
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    assert!(!adapter.lease_held.load(std::sync::atomic::Ordering::SeqCst));
}

struct BackgroundTargetAdapter {
    focused: std::sync::atomic::AtomicBool,
    hit_tests: std::sync::atomic::AtomicUsize,
    moved_to: Mutex<Option<MouseEvent>>,
}

impl ObservationOps for BackgroundTargetAdapter {
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
        self.hit_tests
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.focused.load(std::sync::atomic::Ordering::SeqCst) {
            Ok(HitTestResult::ReachesTarget)
        } else {
            Ok(HitTestResult::InterceptedBy {
                role: Some("window".into()),
                name: Some("Foreground app".into()),
                bounds: None,
            })
        }
    }
}

impl ActionOps for BackgroundTargetAdapter {}

impl InputOps for BackgroundTargetAdapter {
    fn mouse_event(
        &self,
        event: MouseEvent,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        *self.moved_to.lock().unwrap() = Some(event);
        Ok(crate::adapter::test_report())
    }
}

impl SystemOps for BackgroundTargetAdapter {
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
        _window: &crate::WindowInfo,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        self.focused
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

#[test]
fn headed_hover_defers_hit_testing_until_after_focus() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = BackgroundTargetAdapter {
        focused: std::sync::atomic::AtomicBool::new(false),
        hit_tests: std::sync::atomic::AtomicUsize::new(0),
        moved_to: Mutex::new(None),
    };

    execute(
        ref_args(snapshot_id),
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert!(adapter.focused.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(
        adapter.hit_tests.load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    assert!(adapter.moved_to.lock().unwrap().is_some());
}

#[test]
fn timeout_none_is_single_shot() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = StaleThenOkAdapter::new(1);

    let error = execute(
        HoverArgs {
            ref_id: Some(format!("@{}:e1", snapshot_id)),
            xy: None,
            duration_ms: None,
            timeout_ms: None,
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();

    assert_eq!(error.code(), "STALE_REF");
    assert_eq!(adapter.retry.calls(), 1);
}

#[test]
fn expired_xy_budget_never_dispatches_mouse_move() {
    let adapter = HoverCaptureAdapter::new();

    let err = execute(
        HoverArgs {
            ref_id: None,
            xy: Some((5.0, 6.0)),
            duration_ms: None,
            timeout_ms: Some(0),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();

    assert_eq!(err.code(), "TIMEOUT");
    let AppError::Adapter(adapter_error) = &err else {
        panic!("expected adapter timeout")
    };
    assert_eq!(
        adapter_error
            .details
            .as_ref()
            .and_then(|details| details.get("kind")),
        Some(&serde_json::json!("actionability_timeout"))
    );
    assert!(adapter.moved_to.lock().unwrap().is_none());
}
