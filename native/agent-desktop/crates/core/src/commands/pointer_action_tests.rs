use super::*;
use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::refs::refs_store::RefStore;
use crate::refs::refs_test_support::HomeGuard;
use crate::refs::{RefEntry, RefMap};
use crate::{
    AdapterError, DeliverySemantics, ErrorCode, Rect, actions::capability,
    adapter::hit_test::HitTestResult,
};
use std::sync::atomic::{AtomicU32, Ordering};

#[test]
fn unstable_bounds_are_retryable() {
    let err: AppError = AdapterError::new(ErrorCode::ActionFailed, "bounds changed")
        .with_details(json!({ "check": "stable", "observed_bounds_hash": 42 }))
        .into();

    assert!(is_retryable_point_error(&err));
}

#[test]
fn occlusion_failure_is_retryable() {
    let err: AppError = AdapterError::new(ErrorCode::ActionFailed, "target is occluded")
        .with_details(json!({ "check": "receives_events" }))
        .into();

    assert!(is_retryable_point_error(&err));
}

#[test]
fn hidden_target_failure_is_retryable() {
    let err: AppError = AdapterError::new(ErrorCode::ActionFailed, "target is hidden")
        .with_details(json!({ "check": "visible" }))
        .into();

    assert!(is_retryable_point_error(&err));
}

#[test]
fn app_unresponsive_requires_explicit_retry_evidence() {
    let err: AppError = AdapterError::app_unresponsive("Fixture").into();

    assert!(!is_retryable_point_error(&err));
}

fn point_ref_snapshot() -> String {
    let store = RefStore::new().unwrap();
    let mut refmap = RefMap::new();
    refmap.allocate(RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(42),
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
            source_app: Some("Fixture".into()),
            source_window_id: Some("w-42".into()),
            source_window_title: Some("Window".into()),
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

fn point_args(snapshot_id: &str) -> crate::commands::point_resolve::PointResolveArgs<'static> {
    crate::commands::point_resolve::PointResolveArgs {
        ref_id: Some(Box::leak(format!("@{snapshot_id}:e1").into_boxed_str())),
        xy: None,
        missing_input_message: "target required",
        headed_requirement: crate::HeadedRequirement::None,
    }
}

struct TerminalAfterRetryAdapter {
    bounds_reads: AtomicU32,
}

impl ObservationOps for TerminalAfterRetryAdapter {
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
        if self.bounds_reads.fetch_add(1, Ordering::SeqCst) == 0 {
            return Ok(Some(Rect {
                x: 1.0,
                y: 2.0,
                width: 3.0,
                height: 4.0,
            }));
        }
        crate::wait::deadline::sleep(std::time::Duration::from_secs(6));
        Err(AdapterError::new(ErrorCode::StaleRef, "terminal target")
            .with_suggestion("Run 'snapshot' to refresh, then retry with the updated ref.")
            .with_disposition(DeliverySemantics::not_delivered()))
    }
}

impl ActionOps for TerminalAfterRetryAdapter {}
impl InputOps for TerminalAfterRetryAdapter {}
impl SystemOps for TerminalAfterRetryAdapter {}

#[test]
fn terminal_stale_ref_is_preserved_after_retry_budget_expires() {
    let _guard = HomeGuard::new();
    let _clock = crate::wait::deadline::VirtualClock::freeze();
    let snapshot_id = point_ref_snapshot();
    let adapter = TerminalAfterRetryAdapter {
        bounds_reads: AtomicU32::new(0),
    };
    let deadline = crate::Deadline::after(5_000).unwrap();

    let err = match wait_for_point_with_deadline(
        point_args(&snapshot_id),
        deadline,
        &adapter,
        &crate::CommandContext::default(),
    ) {
        Ok(_) => panic!("terminal stale ref must not resolve"),
        Err(err) => err,
    };

    assert_eq!(deadline.remaining(), std::time::Duration::ZERO);
    assert_eq!(err.code(), "STALE_REF");
}

struct UnresponsiveThenReadyAdapter {
    resolve_calls: AtomicU32,
}

impl ObservationOps for UnresponsiveThenReadyAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        if self.resolve_calls.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(AdapterError::app_unresponsive("Fixture")
                .with_details(json!({ "retryable": true })));
        }
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
        Ok(HitTestResult::ReachesTarget)
    }
}

impl ActionOps for UnresponsiveThenReadyAdapter {}
impl InputOps for UnresponsiveThenReadyAdapter {}
impl SystemOps for UnresponsiveThenReadyAdapter {}

#[test]
fn explicitly_retryable_app_unresponsive_recovers_within_shared_deadline() {
    let _guard = HomeGuard::new();
    let snapshot_id = point_ref_snapshot();
    let adapter = UnresponsiveThenReadyAdapter {
        resolve_calls: AtomicU32::new(0),
    };
    let deadline = crate::Deadline::after(5_000).unwrap();

    let resolved = wait_for_point_with_deadline(
        point_args(&snapshot_id),
        deadline,
        &adapter,
        &crate::CommandContext::default(),
    )
    .unwrap();

    assert_eq!((resolved.point.x, resolved.point.y), (30.0, 50.0));
    assert_eq!(adapter.resolve_calls.load(Ordering::SeqCst), 3);
}

struct ZeroSizeUnscrollableAdapter {
    scrolls: AtomicU32,
    leases: AtomicU32,
}

impl ObservationOps for ZeroSizeUnscrollableAdapter {
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
            x: 5.0,
            y: 5.0,
            width: 0.0,
            height: 0.0,
        }))
    }
}

impl ActionOps for ZeroSizeUnscrollableAdapter {
    fn scroll_into_view(
        &self,
        _handle: &NativeHandle,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        self.scrolls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

impl InputOps for ZeroSizeUnscrollableAdapter {}

impl SystemOps for ZeroSizeUnscrollableAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        self.leases.fetch_add(1, Ordering::SeqCst);
        crate::InteractionLease::guarded(deadline, ())
    }
}

#[test]
fn an_unchanged_bounds_hash_after_scroll_stops_the_scroll_retries() {
    let _guard = HomeGuard::new();
    let snapshot_id = point_ref_snapshot();
    let adapter = ZeroSizeUnscrollableAdapter {
        scrolls: AtomicU32::new(0),
        leases: AtomicU32::new(0),
    };
    let deadline = crate::Deadline::after(250).unwrap();

    let err = match wait_for_point_with_deadline(
        point_args(&snapshot_id),
        deadline,
        &adapter,
        &crate::CommandContext::default(),
    ) {
        Ok(_) => panic!("a permanently zero-size target cannot become actionable"),
        Err(err) => err,
    };

    assert_eq!(err.code(), "TIMEOUT");
    assert_eq!(
        adapter.scrolls.load(Ordering::SeqCst),
        1,
        "a scroll that left the target bounds unchanged must not be retried"
    );
    assert_eq!(adapter.leases.load(Ordering::SeqCst), 1);
}

#[path = "pointer_action_focus_tests.rs"]
mod focus_tests;
