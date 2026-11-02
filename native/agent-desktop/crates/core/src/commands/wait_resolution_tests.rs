use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AdapterError, ErrorCode,
    actions::capability,
    adapter::NativeHandle,
    commands::wait_predicate,
    refs::refs_store::RefStore,
    refs::refs_test_support::HomeGuard,
    refs::{RefEntry, RefMap},
};
use std::sync::Mutex;

use super::test_support::wait_for_element_test;

struct AmbiguousResolveAdapter;

impl ObservationOps for AmbiguousResolveAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Err(AdapterError::ambiguous_target("2 candidates matched")
            .with_details(serde_json::json!({ "retryable": true })))
    }
}

impl ActionOps for AmbiguousResolveAdapter {}

impl InputOps for AmbiguousResolveAdapter {}

impl SystemOps for AmbiguousResolveAdapter {}

struct TransientResolveAdapter {
    errors: Mutex<Vec<ErrorCode>>,
}

impl ObservationOps for TransientResolveAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        if let Some(code) = self.errors.lock().unwrap().pop() {
            return Err(AdapterError::new(code, "transient resolution failure")
                .with_details(serde_json::json!({ "retryable": true })));
        }
        Ok(NativeHandle::null())
    }
}

impl ActionOps for TransientResolveAdapter {}

impl InputOps for TransientResolveAdapter {}

impl SystemOps for TransientResolveAdapter {}

struct PermissionResolveAdapter;

impl ObservationOps for PermissionResolveAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Err(AdapterError::permission_denied())
    }
}

impl ActionOps for PermissionResolveAdapter {}

impl InputOps for PermissionResolveAdapter {}

impl SystemOps for PermissionResolveAdapter {}

struct TimeoutCaptureAdapter {
    captured_ms: Mutex<Vec<u128>>,
}

impl ObservationOps for TimeoutCaptureAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.captured_ms
            .lock()
            .unwrap()
            .push(deadline.remaining().as_millis());
        Ok(NativeHandle::null())
    }
}

impl ActionOps for TimeoutCaptureAdapter {}

impl InputOps for TimeoutCaptureAdapter {}

impl SystemOps for TimeoutCaptureAdapter {}

fn snapshot_with_one_ref() -> String {
    let mut refmap = RefMap::new();
    refmap.allocate(RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some("Run".into()),
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
    RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap()
}

#[test]
fn element_wait_retries_transient_ambiguous_resolution() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();
    let adapter = TransientResolveAdapter {
        errors: Mutex::new(vec![ErrorCode::AmbiguousTarget]),
    };

    let value = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Exists,
        2000,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["predicate"], "exists");
    assert_eq!(value["observed"]["exists"], true);
}

#[test]
fn element_wait_retries_transient_resolution_timeout() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();
    let adapter = TransientResolveAdapter {
        errors: Mutex::new(vec![ErrorCode::Timeout]),
    };

    let value = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Exists,
        2000,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["observed"]["exists"], true);
}

#[test]
fn element_wait_passes_remaining_budget_to_resolver() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();
    let adapter = TimeoutCaptureAdapter {
        captured_ms: Mutex::new(vec![]),
    };

    let value = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Exists,
        500,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["observed"]["exists"], true);
    let captured = adapter.captured_ms.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert!(captured[0] <= 500);
}

#[test]
fn element_wait_times_out_after_persistent_ambiguous_resolution() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();

    let err = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Exists,
        2000,
        &AmbiguousResolveAdapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "TIMEOUT");
    match err {
        AppError::Adapter(adapter_error) => {
            assert_eq!(
                adapter_error.details.unwrap()["last_observed"]["error"],
                "AMBIGUOUS_TARGET"
            );
        }
        _ => panic!("expected adapter error"),
    }
}

#[test]
fn element_wait_aborts_terminal_permission_error() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();

    let err = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Exists,
        250,
        &PermissionResolveAdapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "PERM_DENIED");
}
