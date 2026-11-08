use super::*;

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
        Ok(HitTestResult::ReachesTarget)
    }
}

impl ActionOps for StaleThenOkAdapter {}

impl InputOps for StaleThenOkAdapter {
    fn drag(
        &self,
        _params: DragParams,
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

#[test]
fn transient_stale_ref_retries_then_succeeds_when_timeout_wired() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    let adapter = StaleThenOkAdapter::new(2).expect_poll_before_lease(3);

    let value = execute(
        DragArgs {
            from: DragEndpoint {
                ref_id: Some(format!("@{}:e1", snapshot_id)),
                xy: None,
            },
            to: DragEndpoint {
                ref_id: Some(format!("@{}:e2", snapshot_id)),
                xy: None,
            },
            duration_ms: None,
            drop_delay_ms: None,
            timeout_ms: Some(5_000),
            wait_for_scope: WaitForScope::default(),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert!(value.get("dragged").is_none());
    assert!(adapter.retry.calls() >= 3);
    assert_eq!(adapter.lease_acquisitions.load(Ordering::SeqCst), 1);
}

struct OccludedFromAdapter {
    captured: Mutex<Option<DragParams>>,
}

impl ObservationOps for OccludedFromAdapter {
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
        Ok(HitTestResult::InterceptedBy {
            role: Some("AXSheet".into()),
            name: Some("Save changes?".into()),
            bounds: None,
        })
    }
}

impl ActionOps for OccludedFromAdapter {}

impl InputOps for OccludedFromAdapter {
    fn drag(
        &self,
        params: DragParams,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        *self.captured.lock().unwrap() = Some(params);
        Ok(crate::adapter::test_report())
    }
}

impl SystemOps for OccludedFromAdapter {
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
        Ok(())
    }
}

#[test]
fn drag_from_occluded_ref_fails_preflight_before_dispatch() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    let adapter = OccludedFromAdapter {
        captured: Mutex::new(None),
    };

    let err = execute(
        cross_app_args(snapshot_id),
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
    assert!(adapter.captured.lock().unwrap().is_none());
}

struct MutuallyOffscreenAdapter {
    visible_pid: AtomicU32,
    dispatched: AtomicU32,
}

impl ObservationOps for MutuallyOffscreenAdapter {
    fn resolve_element_strict(
        &self,
        entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::new(entry.process.pid.get()))
    }

    fn get_element_bounds(
        &self,
        handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        let pid = *handle.downcast_ref::<u32>().unwrap();
        if self.visible_pid.load(Ordering::SeqCst) != pid {
            return Ok(None);
        }
        Ok(Some(Rect {
            x: f64::from(pid) * 100.0,
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
        Ok(HitTestResult::ReachesTarget)
    }
}

impl ActionOps for MutuallyOffscreenAdapter {
    fn scroll_into_view(
        &self,
        handle: &NativeHandle,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        self.visible_pid
            .store(*handle.downcast_ref::<u32>().unwrap(), Ordering::SeqCst);
        Ok(())
    }
}

impl InputOps for MutuallyOffscreenAdapter {
    fn drag(
        &self,
        _params: DragParams,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        self.dispatched.fetch_add(1, Ordering::SeqCst);
        Ok(crate::adapter::test_report())
    }
}

impl SystemOps for MutuallyOffscreenAdapter {
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
        Ok(())
    }
}

#[test]
fn drag_does_not_dispatch_when_endpoints_cannot_remain_visible_together() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    let adapter = MutuallyOffscreenAdapter {
        visible_pid: AtomicU32::new(1),
        dispatched: AtomicU32::new(0),
    };
    let mut args = cross_app_args(snapshot_id);
    args.timeout_ms = Some(500);

    let error = execute(args, &adapter, &CommandContext::default().with_headed(true)).unwrap_err();

    assert_eq!(error.code(), "TIMEOUT");
    assert_eq!(adapter.dispatched.load(Ordering::SeqCst), 0);
}

#[test]
fn timeout_none_is_single_shot() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    let adapter = StaleThenOkAdapter::new(1);

    let error = execute(
        DragArgs {
            from: DragEndpoint {
                ref_id: Some(format!("@{}:e1", snapshot_id)),
                xy: None,
            },
            to: DragEndpoint {
                ref_id: Some(format!("@{}:e2", snapshot_id)),
                xy: None,
            },
            duration_ms: None,
            drop_delay_ms: None,
            timeout_ms: None,
            wait_for_scope: WaitForScope::default(),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();

    assert_eq!(error.code(), "STALE_REF");
    assert_eq!(adapter.retry.calls(), 1);
}

#[test]
fn expired_xy_budget_never_dispatches_drag() {
    let adapter = DragCaptureAdapter::new();
    let mut args = xy_args(None);
    args.timeout_ms = Some(0);

    let err = execute(args, &adapter, &CommandContext::default().with_headed(true)).unwrap_err();

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
    assert!(adapter.captured.lock().unwrap().is_none());
}
