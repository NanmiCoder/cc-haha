use super::*;

fn resolve_test_point(
    args: PointResolveArgs<'_>,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<ResolvedPoint, AppError> {
    let deadline = crate::Deadline::standard().unwrap();
    let lease = crate::InteractionLease::guarded(deadline, ()).unwrap();
    resolve_point_from_ref_or_xy_with_context(args, adapter, context, deadline, &lease)
}
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    ErrorCode, Rect,
    actions::capability,
    adapter::NativeHandle,
    adapter::hit_test::HitTestResult,
    refs::refs_store::RefStore,
    refs::refs_test_support::HomeGuard,
    refs::{RefEntry, RefMap},
};
use std::sync::atomic::{AtomicU32, Ordering};

#[test]
fn physical_input_requires_headed_context() {
    let err = require_cursor_policy(&CommandContext::default(), "mouse-move").unwrap_err();

    assert_eq!(err.code(), "POLICY_DENIED");
}

#[test]
fn headed_context_allows_physical_input() {
    require_cursor_policy(&CommandContext::default().with_headed(true), "mouse-move").unwrap();
}

/// An adapter whose `hit_test` outcome is fixed per test, so each occlusion
/// scenario (F27) exercises the real `resolve_point_from_ref_or_xy_with_context`
/// path rather than a mock that always echoes success.
struct HitTestOutcomeAdapter {
    outcome: Result<HitTestResult, AdapterError>,
}

impl ObservationOps for HitTestOutcomeAdapter {
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
        _point: Point,
        _deadline: crate::Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        self.outcome.clone()
    }
}

impl ActionOps for HitTestOutcomeAdapter {}
impl InputOps for HitTestOutcomeAdapter {}
impl SystemOps for HitTestOutcomeAdapter {}

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
            source_app: None,
            source_window_id: None,
            source_window_title: None,
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

fn ref_args(snapshot_id: &str) -> PointResolveArgs<'static> {
    PointResolveArgs {
        ref_id: Some(Box::leak(format!("@{snapshot_id}:e1").into_boxed_str())),
        xy: None,
        missing_input_message: "Provide a ref (@<snapshot_id>:e1) or --xy x,y",
        headed_requirement: crate::HeadedRequirement::None,
    }
}

/// F27 regression: previously the ref-targeted path never called
/// `adapter.hit_test` at all, so an occluded target resolved to a point and
/// dispatch proceeded blind. This proves `InterceptedBy` now blocks
/// resolution and names the occluder.
#[test]
fn intercepted_by_blocks_ref_targeted_point_resolution() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = HitTestOutcomeAdapter {
        outcome: Ok(HitTestResult::InterceptedBy {
            role: Some("AXSheet".into()),
            name: Some("Save changes?".into()),
            bounds: None,
        }),
    };

    let result = resolve_test_point(ref_args(&snapshot_id), &adapter, &CommandContext::default());
    let err = match result {
        Ok(_) => panic!("occluded ref target must not resolve to a point"),
        Err(err) => err,
    };

    assert_eq!(err.code(), ErrorCode::ActionFailed.as_str());
    let message = err.to_string();
    assert!(message.contains("AXSheet"));
}

#[test]
fn reaches_target_allows_ref_targeted_point_resolution() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = HitTestOutcomeAdapter {
        outcome: Ok(HitTestResult::ReachesTarget),
    };

    let resolved =
        resolve_test_point(ref_args(&snapshot_id), &adapter, &CommandContext::default()).unwrap();

    assert_eq!(resolved.point.x, 110.0);
    assert_eq!(resolved.point.y, 205.0);
}

#[test]
fn unknown_hit_test_result_allows_ref_targeted_resolution() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = HitTestOutcomeAdapter {
        outcome: Ok(HitTestResult::Unknown),
    };

    let resolved =
        resolve_test_point(ref_args(&snapshot_id), &adapter, &CommandContext::default()).unwrap();
    assert_eq!((resolved.point.x, resolved.point.y), (110.0, 205.0));
}

#[test]
fn unsupported_hit_test_allows_ref_targeted_resolution() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = HitTestOutcomeAdapter {
        outcome: Err(AdapterError::not_supported("hit_test")),
    };

    let resolved =
        resolve_test_point(ref_args(&snapshot_id), &adapter, &CommandContext::default()).unwrap();
    assert_eq!((resolved.point.x, resolved.point.y), (110.0, 205.0));
}

#[test]
fn hit_test_probe_error_is_preserved_for_ref_targeted_resolution() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = HitTestOutcomeAdapter {
        outcome: Err(AdapterError::internal(
            "AXUIElementCopyElementAtPosition failed",
        )),
    };

    let err = match resolve_test_point(ref_args(&snapshot_id), &adapter, &CommandContext::default())
    {
        Ok(_) => panic!("failed hit-test evidence must fail closed"),
        Err(err) => err,
    };

    assert_eq!(err.code(), "INTERNAL");
}

/// Raw `--xy` input stays raw by design: no ref means no occlusion
/// check, even against an adapter that would otherwise report occlusion.
#[test]
fn raw_xy_input_never_calls_hit_test() {
    let adapter = HitTestOutcomeAdapter {
        outcome: Ok(HitTestResult::InterceptedBy {
            role: Some("AXSheet".into()),
            name: None,
            bounds: None,
        }),
    };

    let resolved = resolve_test_point(
        PointResolveArgs {
            ref_id: None,
            xy: Some((5.0, 6.0)),
            missing_input_message: "Provide a ref (@<snapshot_id>:e1) or --xy x,y",
            headed_requirement: crate::HeadedRequirement::None,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!((resolved.point.x, resolved.point.y), (5.0, 6.0));
}

fn focus_ref_entry() -> RefEntry {
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(42),
            process_instance: Some("instance-42".into()),
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
            source_window_title: Some("Fixture".into()),
            source_window_bounds_hash: None,
            source_surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    }
}

struct FocusFailureAdapter {
    resolve_error: Option<AdapterError>,
    focus_error: Option<AdapterError>,
    focus_calls: AtomicU32,
}

impl ObservationOps for FocusFailureAdapter {}
impl ActionOps for FocusFailureAdapter {}
impl InputOps for FocusFailureAdapter {}

impl SystemOps for FocusFailureAdapter {
    fn resolve_window_strict(
        &self,
        window: &crate::WindowInfo,
        _deadline: crate::Deadline,
    ) -> Result<crate::WindowInfo, AdapterError> {
        match &self.resolve_error {
            Some(error) => Err(error.clone()),
            None => Ok(window.clone()),
        }
    }

    fn focus_window(
        &self,
        _window: &crate::WindowInfo,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        self.focus_calls.fetch_add(1, Ordering::SeqCst);
        match &self.focus_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
}

fn focus_test_lease() -> crate::InteractionLease {
    crate::InteractionLease::guarded(crate::Deadline::standard().unwrap(), ()).unwrap()
}

#[test]
fn transient_window_resolution_failure_blocks_headed_input() {
    let adapter = FocusFailureAdapter {
        resolve_error: Some(AdapterError::app_unresponsive("Fixture")),
        focus_error: None,
        focus_calls: AtomicU32::new(0),
    };

    let error = focus_for_physical_input(
        Some(&focus_ref_entry()),
        &adapter,
        &CommandContext::default().with_headed(true),
        &focus_test_lease(),
    )
    .unwrap_err();

    assert_eq!(error.code(), "APP_UNRESPONSIVE");
    assert_eq!(adapter.focus_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn transient_focus_failure_blocks_headed_input() {
    let adapter = FocusFailureAdapter {
        resolve_error: None,
        focus_error: Some(AdapterError::new(
            ErrorCode::ActionFailed,
            "window could not be raised",
        )),
        focus_calls: AtomicU32::new(0),
    };

    let error = focus_for_physical_input(
        Some(&focus_ref_entry()),
        &adapter,
        &CommandContext::default().with_headed(true),
        &focus_test_lease(),
    )
    .unwrap_err();

    assert_eq!(error.code(), "ACTION_FAILED");
    assert_eq!(adapter.focus_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn permission_failure_during_focus_is_preserved() {
    let adapter = FocusFailureAdapter {
        resolve_error: None,
        focus_error: Some(AdapterError::permission_denied()),
        focus_calls: AtomicU32::new(0),
    };

    let err = focus_for_physical_input(
        Some(&focus_ref_entry()),
        &adapter,
        &CommandContext::default().with_headed(true),
        &focus_test_lease(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "PERM_DENIED");
}
