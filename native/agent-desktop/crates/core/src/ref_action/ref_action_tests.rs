use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    DeliverySemantics, ErrorCode,
    actions::action::Action,
    actions::action_result::ActionResult,
    actions::capability,
    adapter::{NativeHandle, SnapshotSurface},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU32, Ordering},
};

struct DropProbe(Arc<AtomicU32>);

impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

struct SuccessfulAdapter {
    drops: Arc<AtomicU32>,
    dispatched_policies: Mutex<Vec<crate::InteractionPolicy>>,
}

impl SuccessfulAdapter {
    fn new() -> Self {
        Self {
            drops: Arc::new(AtomicU32::new(0)),
            dispatched_policies: Mutex::new(Vec::new()),
        }
    }
}

impl ObservationOps for SuccessfulAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::new(DropProbe(Arc::clone(&self.drops))))
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for SuccessfulAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.dispatched_policies
            .lock()
            .unwrap()
            .push(request.policy);
        Ok(ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for SuccessfulAdapter {}

impl SystemOps for SuccessfulAdapter {
    crate::adapter::guarded_interaction_lease!();
    crate::adapter::exact_window_focus!();
}

struct FailingAdapter {
    drops: Arc<AtomicU32>,
}

impl ObservationOps for FailingAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::new(DropProbe(Arc::clone(&self.drops))))
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for FailingAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Err(AdapterError::internal("dispatch failed"))
    }
}

impl InputOps for FailingAdapter {}

impl SystemOps for FailingAdapter {
    crate::adapter::guarded_interaction_lease!();
}

struct ProcessReplacingAdapter;

impl ObservationOps for ProcessReplacingAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for ProcessReplacingAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        let expected = request
            .expected_process()
            .ok_or_else(|| AdapterError::internal("missing expected process identity"))?;
        if expected.instance != "replacement-generation" {
            return Err(AdapterError::new(
                ErrorCode::StaleRef,
                "process generation changed before physical dispatch",
            )
            .with_suggestion("Run 'snapshot' to refresh, then retry with the updated ref.")
            .with_disposition(DeliverySemantics::not_delivered()));
        }
        Ok(ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for ProcessReplacingAdapter {}
impl SystemOps for ProcessReplacingAdapter {
    crate::adapter::guarded_interaction_lease!();
}

struct TraceFailureAdapter {
    path: std::path::PathBuf,
    fail_after_dispatch: bool,
    dispatches: AtomicU32,
}

impl ObservationOps for TraceFailureAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for TraceFailureAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        if self.fail_after_dispatch {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&self.path)
                .unwrap()
                .set_len(crate::trace::MAX_TRACE_FILE_BYTES)
                .unwrap();
        }
        Ok(ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for TraceFailureAdapter {}
impl SystemOps for TraceFailureAdapter {
    crate::adapter::guarded_interaction_lease!();
}

fn entry() -> RefEntry {
    let bounds = crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
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
            bounds: Some(bounds),
            bounds_hash: bounds.bounds_hash(),
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
            source_surface: SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    }
}

#[test]
fn successful_action_drops_resolved_payload() {
    let adapter = SuccessfulAdapter::new();
    let result = execute_entry(&adapter, &entry(), ActionRequest::headless(Action::Click)).unwrap();

    assert_eq!(result.action, "click");
    assert_eq!(adapter.drops.load(Ordering::SeqCst), 1);
}

#[test]
fn headed_preflight_preserves_requested_physical_delivery() {
    let adapter = SuccessfulAdapter::new();

    execute_entry(&adapter, &entry(), ActionRequest::headed(Action::Click)).unwrap();

    assert_eq!(
        adapter.dispatched_policies.lock().unwrap().as_slice(),
        &[crate::InteractionPolicy::headed()]
    );
}

#[test]
fn failed_action_still_drops_resolved_payload() {
    let adapter = FailingAdapter {
        drops: Arc::new(AtomicU32::new(0)),
    };

    let err =
        execute_entry(&adapter, &entry(), ActionRequest::headless(Action::Click)).unwrap_err();

    assert_eq!(err.code, crate::ErrorCode::Internal);
    assert_eq!(adapter.drops.load(Ordering::SeqCst), 1);
}

#[test]
fn replacement_between_resolution_and_dispatch_fails_before_delivery() {
    let error = execute_entry(
        &ProcessReplacingAdapter,
        &entry(),
        ActionRequest::headless(Action::Click),
    )
    .unwrap_err();

    assert_eq!(error.code, crate::ErrorCode::StaleRef);
    assert_eq!(
        error.disposition.delivery(),
        crate::DeliveryDisposition::NotDelivered
    );
}

#[test]
fn execute_entry_with_context_emits_trace_events() {
    let trace_path = std::env::temp_dir().join(format!(
        "agent-desktop-ref-action-trace-{}.jsonl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context =
        CommandContext::new(Some("test-session".into()), Some(trace_path.clone()), false).unwrap();
    let adapter = SuccessfulAdapter::new();

    let _ = execute_entry_with_context(
        &adapter,
        &entry(),
        ActionRequest::headless(Action::Click),
        &context,
    );

    let body = std::fs::read_to_string(&trace_path).unwrap();
    assert!(
        body.contains("actionability.check.start"),
        "expected actionability trace event"
    );
    assert!(
        body.contains("action.dispatch.start"),
        "expected dispatch trace event"
    );
    for line in body.lines() {
        let record: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(
            record["session_id"], "test-session",
            "session_id must appear in every trace record when set"
        );
    }
    let _ = std::fs::remove_file(trace_path);
}

#[test]
fn trace_records_omit_session_id_when_context_has_none() {
    let trace_path = std::env::temp_dir().join(format!(
        "agent-desktop-ref-action-no-session-trace-{}.jsonl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context = CommandContext::new(None, Some(trace_path.clone()), false).unwrap();
    let adapter = SuccessfulAdapter::new();

    let _ = execute_entry_with_context(
        &adapter,
        &entry(),
        ActionRequest::headless(Action::Click),
        &context,
    );

    let body = std::fs::read_to_string(&trace_path).unwrap();
    assert!(
        body.contains("action.dispatch.start"),
        "expected dispatch trace event"
    );
    for line in body.lines() {
        let record: serde_json::Value = serde_json::from_str(line).unwrap();
        assert!(
            record.get("session_id").is_none(),
            "session_id must be absent when context has no session"
        );
    }
    let _ = std::fs::remove_file(trace_path);
}

#[test]
fn ref_label_from_entry_uses_role_and_path_indices() {
    let no_path = entry();
    assert_eq!(ref_label_from_entry(&no_path), "<button>");

    let mut with_path = entry();
    with_path.scope.path = smallvec::smallvec![2, 0, 3];
    assert_eq!(ref_label_from_entry(&with_path), "<button/2/0/3>");
}

#[path = "ref_action_trace_failure_tests.rs"]
mod trace_failure_tests;

#[path = "ref_action_cursor_overlay_tests.rs"]
mod cursor_overlay_tests;

#[path = "ref_action_scroll_recovery_tests.rs"]
mod scroll_recovery_tests;

#[path = "ref_action_moving_incrementor_tests.rs"]
mod moving_incrementor_tests;

#[path = "ref_action_disabled_offscreen_tests.rs"]
mod disabled_offscreen_tests;

#[path = "ref_action_keyboard_tests.rs"]
mod keyboard_tests;
