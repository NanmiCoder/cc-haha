use super::*;
use crate::{
    AdapterError, AppInfo, ErrorCode,
    actions::action::Action,
    actions::capability,
    adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps},
};
use std::sync::atomic::{AtomicU32, Ordering};

/// F23 follow-up: covers the `APP_NOT_FOUND` branch of terminal process-state
/// enrichment, split out of `ref_action_wait_process_state_tests.rs` to keep
/// both files under the repo's 400 LOC hard limit.
fn entry() -> RefEntry {
    RefEntry {
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
            bounds: Some(crate::Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            bounds_hash: Some(1),
        },
        capabilities: crate::RefCapabilities {
            states: vec![],
            available_actions: vec![capability::CLICK.into()],
        },
        source: crate::RefSource {
            source_app: Some("Original".into()),
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: crate::snapshot::snapshot_surface::SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    }
}

fn request_with_timeout(timeout_ms: u64) -> ActionRequest {
    ActionRequest::headless(Action::Click).with_timeout_ms(Some(timeout_ms))
}

struct TicksThenAppNotFoundAdapter {
    resolve_calls: AtomicU32,
    probe_calls: AtomicU32,
}

impl ObservationOps for TicksThenAppNotFoundAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        let attempt = self.resolve_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if attempt < 3 {
            Err(AdapterError::new(ErrorCode::StaleRef, "not yet")
                .with_details(serde_json::json!({ "retryable": true })))
        } else {
            Err(AdapterError::new(ErrorCode::AppNotFound, "app gone"))
        }
    }
}

impl ActionOps for TicksThenAppNotFoundAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        Ok(crate::actions::action_result::ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for TicksThenAppNotFoundAdapter {}

impl SystemOps for TicksThenAppNotFoundAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn process_state(
        &self,
        _process: crate::ProcessIdentity,
        _deadline: crate::Deadline,
    ) -> Result<crate::system::process_state::ProcessState, AdapterError> {
        self.probe_calls.fetch_add(1, Ordering::SeqCst);
        Ok(crate::system::process_state::ProcessState::Running)
    }
}

struct AppNotFoundExitedProcessAdapter;

impl ObservationOps for AppNotFoundExitedProcessAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Err(AdapterError::new(ErrorCode::AppNotFound, "app gone"))
    }
}

impl ActionOps for AppNotFoundExitedProcessAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        Ok(crate::actions::action_result::ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for AppNotFoundExitedProcessAdapter {}

impl SystemOps for AppNotFoundExitedProcessAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn process_state(
        &self,
        _process: crate::ProcessIdentity,
        _deadline: crate::Deadline,
    ) -> Result<crate::system::process_state::ProcessState, AdapterError> {
        Ok(crate::system::process_state::ProcessState::Exited { code: None })
    }
}

#[test]
fn terminal_app_not_found_against_exited_process_carries_process_state_detail() {
    let err = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &AppNotFoundExitedProcessAdapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        ActionRequest::headless(Action::Click),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap_err();

    assert_eq!(
        err.code,
        ErrorCode::AppNotFound,
        "an Exited (not Unresponsive) classification must not replace the original error code"
    );
    assert_eq!(
        err.details.as_ref().and_then(|d| d.get("process_state")),
        Some(&serde_json::json!("exited")),
        "APP_NOT_FOUND against a dead pid must carry details.process_state = \"exited\""
    );
}

struct AppNotFoundUnresponsiveProcessAdapter {
    probe_calls: AtomicU32,
}

impl ObservationOps for AppNotFoundUnresponsiveProcessAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        Ok(vec![AppInfo {
            name: "Original".into(),
            pid: crate::ProcessId::new(1),
            bundle_id: None,
            process_instance: Some("test-instance".into()),
            presentation: None,
        }])
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Err(AdapterError::new(ErrorCode::AppNotFound, "app gone"))
    }
}

impl ActionOps for AppNotFoundUnresponsiveProcessAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        Ok(crate::actions::action_result::ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for AppNotFoundUnresponsiveProcessAdapter {}

impl SystemOps for AppNotFoundUnresponsiveProcessAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn process_state(
        &self,
        _process: crate::ProcessIdentity,
        _deadline: crate::Deadline,
    ) -> Result<crate::system::process_state::ProcessState, AdapterError> {
        self.probe_calls.fetch_add(1, Ordering::SeqCst);
        Ok(crate::system::process_state::ProcessState::Unresponsive)
    }
}

#[test]
fn terminal_app_not_found_against_unresponsive_process_surfaces_app_unresponsive() {
    let adapter = AppNotFoundUnresponsiveProcessAdapter {
        probe_calls: AtomicU32::new(0),
    };

    let err = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        ActionRequest::headless(Action::Click),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap_err();

    assert_eq!(
        err.code,
        ErrorCode::AppUnresponsive,
        "an Unresponsive classification must upgrade APP_NOT_FOUND to APP_UNRESPONSIVE"
    );
    assert!(
        err.suggestion.is_some(),
        "APP_UNRESPONSIVE must carry a recovery suggestion"
    );
    assert_eq!(
        adapter.probe_calls.load(Ordering::SeqCst),
        1,
        "the liveness probe must run exactly once when building the terminal error"
    );
}

#[test]
fn probe_call_count_is_independent_of_auto_wait_tick_count() {
    let adapter = TicksThenAppNotFoundAdapter {
        resolve_calls: AtomicU32::new(0),
        probe_calls: AtomicU32::new(0),
    };

    let err = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        request_with_timeout(5_000),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::AppNotFound);
    assert!(
        adapter.resolve_calls.load(Ordering::SeqCst) >= 3,
        "the poll loop must have ticked multiple times before the terminal error"
    );
    assert_eq!(
        adapter.probe_calls.load(Ordering::SeqCst),
        1,
        "the liveness probe must run exactly once at the terminal boundary, \
         not once per auto-wait tick"
    );
}
