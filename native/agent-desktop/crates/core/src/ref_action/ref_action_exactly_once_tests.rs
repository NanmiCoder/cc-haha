use super::*;
use crate::{
    AdapterError, ErrorCode, Rect,
    actions::action::Action,
    actions::action_request::ActionRequest,
    actions::action_result::ActionResult,
    actions::capability,
    adapter::{ActionOps, InputOps, LiveElement, NativeHandle, ObservationOps, SystemOps},
    refs::RefEntry,
    snapshot::snapshot_surface::SnapshotSurface,
    tree::element_state::ElementState,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Duration,
};

struct DispatchGuardAdapter {
    resolve_calls: AtomicU32,
    live_calls: AtomicU32,
    dispatch_calls: AtomicU32,
    scroll_calls: AtomicU32,
    lease_held: Arc<AtomicBool>,
    preflight_delay_ms: u64,
    mode: &'static str,
}

struct DispatchGuardLease(Arc<AtomicBool>);

impl Drop for DispatchGuardLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl DispatchGuardAdapter {
    fn new(mode: &'static str, preflight_delay_ms: u64) -> Self {
        Self {
            resolve_calls: AtomicU32::new(0),
            live_calls: AtomicU32::new(0),
            dispatch_calls: AtomicU32::new(0),
            scroll_calls: AtomicU32::new(0),
            lease_held: Arc::new(AtomicBool::new(false)),
            preflight_delay_ms,
            mode,
        }
    }
}

impl ObservationOps for DispatchGuardAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        let call = self.resolve_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if self.mode == "resolve_timeout" {
            return Err(AdapterError::timeout("strict resolution timed out"));
        }
        if self.mode == "resolve_timeout_under_lease" && self.lease_held.load(Ordering::SeqCst) {
            return Err(AdapterError::timeout("strict re-resolution timed out"));
        }
        if self.mode == "resolve_uncertain" {
            return Err(AdapterError::timeout("strict resolution was uncertain")
                .with_disposition(crate::DeliverySemantics::uncertain()));
        }
        if self.mode == "ambiguous" && call == 1 {
            return Err(AdapterError::ambiguous_target("two live candidates")
                .with_details(serde_json::json!({ "retryable": true })));
        }
        Ok(NativeHandle::null())
    }

    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<LiveElement, AdapterError> {
        std::thread::sleep(Duration::from_millis(self.preflight_delay_ms));
        let call = self.live_calls.fetch_add(1, Ordering::SeqCst) + 1;
        let live_bounds = match self.mode {
            "moving_once" => bounds_at(100.0),
            "moving_continuously" => bounds_at(f64::from(call + 1) * 10.0),
            "zero_geometry" => zero_bounds(),
            _ => bounds(),
        };
        Ok(LiveElement {
            identity: crate::adapter::live_identity("Run"),
            state: ElementState {
                role: "button".into(),
                states: Vec::new(),
                value: None,
                enabled: Some(true),
                hidden: Some(self.mode == "hidden_after_scroll"),
                offscreen: (self.mode != "zero_geometry").then_some(self.mode == "offscreen_slow"),
            },
            states_complete: true,
            bounds: Some(live_bounds),
            available_actions: vec![capability::CLICK.into()],
        })
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        let observed = self.live_calls.load(Ordering::SeqCst);
        let bounds = match self.mode {
            "moving_once" => bounds_at(100.0),
            "moving_continuously" => bounds_at(f64::from(observed + 1) * 10.0),
            "zero_geometry" => zero_bounds(),
            _ => bounds(),
        };
        Ok(Some(bounds))
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<crate::adapter::hit_test::HitTestResult, AdapterError> {
        Ok(crate::adapter::hit_test::HitTestResult::ReachesTarget)
    }
}

impl ActionOps for DispatchGuardAdapter {
    fn scroll_into_view(
        &self,
        _handle: &NativeHandle,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        self.scroll_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.dispatch_calls.fetch_add(1, Ordering::SeqCst);
        if self.mode == "dispatch_error" {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "post-dispatch verification failed",
            ));
        }
        let result = ActionResult::delivered_unverified("click");
        if self.mode == "ambiguous" {
            return Ok(result.with_details(serde_json::json!({ "mechanism": "AXPress" })));
        }
        Ok(result)
    }
}

impl InputOps for DispatchGuardAdapter {}
impl SystemOps for DispatchGuardAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        self.lease_held.store(true, Ordering::SeqCst);
        crate::InteractionLease::guarded(deadline, DispatchGuardLease(Arc::clone(&self.lease_held)))
    }
}

fn bounds() -> Rect {
    bounds_at(10.0)
}

fn zero_bounds() -> Rect {
    Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    }
}

fn bounds_at(x: f64) -> Rect {
    Rect {
        x,
        y: 10.0,
        width: 20.0,
        height: 20.0,
    }
}

fn entry() -> RefEntry {
    let bounds = bounds();
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
            states: Vec::new(),
            available_actions: vec![capability::CLICK.into()],
        },
        source: crate::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
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

fn execute(adapter: &DispatchGuardAdapter, timeout_ms: u64) -> Result<ActionResult, AdapterError> {
    execute_with_auto_wait(
        RefActionWaitCtx {
            adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        ActionRequest::headless(Action::Click).with_timeout_ms(Some(timeout_ms)),
        crate::ref_action::dispatch_resolved,
    )
}

#[test]
fn failed_preflight_after_scroll_reports_nothing_delivered_and_the_moved_view() {
    let adapter = DispatchGuardAdapter::new("hidden_after_scroll", 0);
    let error = execute(&adapter, 500).unwrap_err();
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    assert_eq!(
        error.details.unwrap()["preparatory_scroll"],
        "may_have_changed_view"
    );
    assert_eq!(adapter.scroll_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn dispatch_failure_is_returned_without_repeating_the_action() {
    let adapter = DispatchGuardAdapter::new("dispatch_error", 0);
    let err = execute(&adapter, 500).unwrap_err();
    assert_eq!(err.code, ErrorCode::ActionFailed);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn poll_resolution_timeout_is_retry_safe_before_dispatch() {
    let adapter = DispatchGuardAdapter::new("resolve_timeout", 0);
    let err = execute(&adapter, 500).unwrap_err();

    assert_eq!(err.code, ErrorCode::Timeout);
    assert_eq!(err.disposition, crate::DeliverySemantics::not_delivered());
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn under_lease_resolution_timeout_is_retry_safe_before_dispatch() {
    let adapter = DispatchGuardAdapter::new("resolve_timeout_under_lease", 0);
    let err = execute(&adapter, 500).unwrap_err();

    assert_eq!(err.code, ErrorCode::Timeout);
    assert_eq!(err.disposition, crate::DeliverySemantics::not_delivered());
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
    assert!(!adapter.lease_held.load(Ordering::SeqCst));
}

#[test]
fn pre_dispatch_resolution_annotation_preserves_stronger_delivery_evidence() {
    let adapter = DispatchGuardAdapter::new("resolve_uncertain", 0);
    let err = execute(&adapter, 500).unwrap_err();

    assert_eq!(err.disposition, crate::DeliverySemantics::uncertain());
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn expired_deadline_after_preflight_prevents_dispatch() {
    let adapter = DispatchGuardAdapter::new("success", 20);
    let err = execute(&adapter, 1).unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn zero_timeout_is_an_explicit_single_attempt() {
    let adapter = DispatchGuardAdapter::new("success", 0);
    execute(&adapter, 0).unwrap();
    assert_eq!(adapter.resolve_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn ambiguity_diagnostic_preserves_adapter_result_details() {
    let adapter = DispatchGuardAdapter::new("ambiguous", 0);
    let result = execute(&adapter, 5_000).unwrap();
    assert_eq!(result.details.as_ref().unwrap()["mechanism"], "AXPress");
    assert_eq!(
        result.details.as_ref().unwrap()["transient_ambiguity"],
        true
    );
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn moved_semantic_target_dispatches_without_positional_wait() {
    let adapter = DispatchGuardAdapter::new("moving_once", 0);
    execute(&adapter, 500).unwrap();
    assert_eq!(adapter.live_calls.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn continuously_moving_semantic_target_dispatches_exactly_once() {
    let adapter = DispatchGuardAdapter::new("moving_continuously", 0);
    execute(&adapter, 60).unwrap();
    assert_eq!(adapter.live_calls.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn expired_preflight_never_scrolls_after_the_deadline() {
    let adapter = DispatchGuardAdapter::new("offscreen_slow", 20);
    let err = execute(&adapter, 1).unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout);
    assert_eq!(adapter.scroll_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
}
#[test]
fn zero_geometry_semantic_click_dispatches_without_scrolling_into_view() {
    let adapter = DispatchGuardAdapter::new("zero_geometry", 0);
    execute(&adapter, 500).unwrap();
    assert_eq!(adapter.scroll_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
}
