use agent_desktop_core::{
    Action, ActionOps, ActionRequest, AdapterError, DeliveryDisposition, DeliverySemantics,
    ElementState, ErrorCode, IdentifierEvidence, InputOps, InteractionLease, LiveElement,
    LiveIdentity, LocatorField, NativeHandle, ObservationOps, Point, ProcessId, Rect,
    RefCapabilities, RefEntry, RefEntryIdentity, RefGeometry, RefProcess, RefScope, RefSource,
    RetryDisposition, SnapshotSurface, SystemOps, WindowInfo, actions::capability,
    adapter::hit_test::HitTestResult, ref_action, tree::state::VisibilityEvidence,
};
use std::sync::atomic::{AtomicU32, Ordering};

struct EnvelopeAdapter {
    live: LiveElement,
    hit: HitTestResult,
    scroll_calls: AtomicU32,
    scroll_ok: bool,
    dispatch_calls: AtomicU32,
}

impl EnvelopeAdapter {
    fn new(live: LiveElement) -> Self {
        Self {
            live,
            hit: HitTestResult::ReachesTarget,
            scroll_calls: AtomicU32::new(0),
            scroll_ok: true,
            dispatch_calls: AtomicU32::new(0),
        }
    }

    fn occluded(mut self, role: &str) -> Self {
        self.hit = HitTestResult::InterceptedBy {
            role: Some(role.into()),
            name: Some("cover".into()),
            bounds: Some(Rect {
                x: 0.0,
                y: 0.0,
                width: 40.0,
                height: 20.0,
            }),
        };
        self
    }
}

impl ObservationOps for EnvelopeAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<LiveElement, AdapterError> {
        Ok(self.live.clone())
    }

    fn get_live_state(
        &self,
        _handle: &NativeHandle,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        Ok(Some(self.live.state.clone()))
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Ok(self.live.bounds)
    }

    fn get_live_actions(
        &self,
        _handle: &NativeHandle,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<Option<Vec<String>>, AdapterError> {
        Ok(Some(self.live.available_actions.clone()))
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: Point,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        Ok(self.hit.clone())
    }
}

impl ActionOps for EnvelopeAdapter {
    fn scroll_into_view(
        &self,
        _handle: &NativeHandle,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        self.scroll_calls.fetch_add(1, Ordering::SeqCst);
        if self.scroll_ok {
            Ok(())
        } else {
            Err(crate::actions::scroll_into_view::unsupported_error())
        }
    }

    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &InteractionLease,
    ) -> Result<agent_desktop_core::ActionResult, AdapterError> {
        self.dispatch_calls.fetch_add(1, Ordering::SeqCst);
        Err(AdapterError::not_supported("execute_action"))
    }
}

impl InputOps for EnvelopeAdapter {}

impl SystemOps for EnvelopeAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }

    fn resolve_window_strict(
        &self,
        window: &WindowInfo,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        Ok(window.clone())
    }

    fn focus_window(
        &self,
        _window: &WindowInfo,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        Ok(())
    }
}

fn live_button(enabled: bool, bounds: Rect) -> LiveElement {
    LiveElement {
        identity: LiveIdentity {
            name: LocatorField::Known("Run".into()),
            description: LocatorField::Absent,
            identifiers: IdentifierEvidence::absent(),
        },
        state: ElementState {
            role: "button".into(),
            states: Vec::new(),
            value: None,
            enabled: Some(enabled),
            hidden: Some(false),
            offscreen: Some(false),
        },
        states_complete: true,
        bounds: Some(bounds),
        available_actions: vec![capability::CLICK.into()],
    }
}

fn entry_for(live: &LiveElement) -> RefEntry {
    let bounds = live.bounds.unwrap_or(Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    });
    RefEntry {
        process: RefProcess {
            pid: ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: RefEntryIdentity {
            retained_object: None,
            role: live.state.role.clone(),
            name: Some("Run".into()),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: RefGeometry {
            bounds_space: None,
            bounds: Some(bounds),
            bounds_hash: bounds.bounds_hash(),
        },
        capabilities: RefCapabilities {
            states: Vec::new(),
            available_actions: live.available_actions.clone(),
        },
        source: RefSource {
            source_app: Some("Fixture".into()),
            source_window_id: Some("w-1".into()),
            source_window_title: Some("Fixture".into()),
            source_window_bounds_hash: None,
            source_surface: SnapshotSurface::Window,
        },
        scope: RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: Default::default(),
        },
    }
}

fn area(width: f64, height: f64) -> Rect {
    Rect {
        x: 10.0,
        y: 10.0,
        width,
        height,
    }
}

fn find_check<'a>(details: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    details["checks"]
        .as_array()
        .expect("details.checks")
        .iter()
        .find(|check| check["check"] == name)
        .unwrap_or_else(|| panic!("missing check {name}"))
}

fn assert_not_delivered(error: &AdapterError) {
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(error.disposition.retry(), RetryDisposition::Safe);
}

fn click(adapter: &EnvelopeAdapter, request: ActionRequest) -> AdapterError {
    let entry = entry_for(&adapter.live);
    ref_action::execute_entry(adapter, &entry, request).expect_err("expected actionability failure")
}

#[test]
fn disabled_timeout_zero_reports_enabled_fail_envelope() {
    let adapter = EnvelopeAdapter::new(live_button(false, area(40.0, 20.0)));
    let error = click(
        &adapter,
        ActionRequest::headless(Action::Click).with_timeout_ms(Some(0)),
    );
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_ne!(error.code, ErrorCode::PlatformNotSupported);
    assert_not_delivered(&error);
    let details = error.details.expect("actionability details");
    assert_eq!(details["actionable"], false);
    let enabled = find_check(&details, "enabled");
    assert_eq!(enabled["status"], "fail");
    assert_eq!(enabled["reason"], "live enabled state is false");
    assert_eq!(adapter.scroll_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn disabled_auto_wait_times_out_with_actionability_timeout() {
    let adapter = EnvelopeAdapter::new(live_button(false, area(40.0, 20.0)));
    let error = click(
        &adapter,
        ActionRequest::headless(Action::Click).with_timeout_ms(Some(80)),
    );
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_not_delivered(&error);
    let details = error.details.expect("timeout details");
    assert_eq!(details["kind"], "actionability_timeout");
    let last = details.get("last_report").expect("last_report on timeout");
    let report = last.get("report").cloned().unwrap_or_else(|| last.clone());
    let enabled = find_check(&report, "enabled");
    assert_eq!(enabled["status"], "fail");
    assert_eq!(enabled["reason"], "live enabled state is false");
}

#[test]
fn zero_bounds_click_reports_visible_fail_after_scroll_seam() {
    let adapter = EnvelopeAdapter::new(live_button(true, area(0.0, 20.0)));
    let error = click(
        &adapter,
        ActionRequest::headless(Action::Click).with_timeout_ms(Some(0)),
    );
    assert_eq!(adapter.scroll_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_ne!(error.code, ErrorCode::PlatformNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(error.disposition.retry(), RetryDisposition::Safe);
    let details = error.details.expect("actionability details");
    assert_eq!(details["preparatory_scroll"], "may_have_changed_view");
    let visible = find_check(&details, "visible");
    assert_eq!(visible["status"], "fail");
    assert_eq!(visible["reason"], "bounds are zero-sized");
}

/// A scroll recovery that cannot run must not become the answer. The caller
/// keeps the actionability diagnosis - zero bounds failed the visible check -
/// and the refused recovery is recorded beside it, so neither the real cause
/// nor the attempt is lost. The code stays ACTION_FAILED and never becomes
/// PLATFORM_NOT_SUPPORTED, which is what this case originally guarded.
#[test]
fn zero_bounds_without_scroll_impl_is_not_platform_not_supported() {
    let mut adapter = EnvelopeAdapter::new(live_button(true, area(0.0, 10.0)));
    adapter.scroll_ok = false;
    let error = click(
        &adapter,
        ActionRequest::headless(Action::Click).with_timeout_ms(Some(0)),
    );
    assert_eq!(adapter.scroll_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_ne!(error.code, ErrorCode::PlatformNotSupported);
    assert_not_delivered(&error);
    let details = error.details.expect("actionability details");
    let attempted = &details["scroll_into_view_attempted"];
    assert!(
        attempted["message"]
            .as_str()
            .is_some_and(|message| message.contains("ScrollIntoView")),
        "the refused recovery is recorded as a detail, got: {details}"
    );
    let visible = find_check(&details, "visible");
    assert_eq!(
        visible["status"], "fail",
        "the recovery failure must not replace the diagnosis it was recovering from"
    );
    let defaulted = AdapterError::not_supported("scroll_into_view");
    assert_ne!(error.code, defaulted.code);
}

#[test]
fn zero_bounds_is_visible_applicable_true_result_false() {
    let live = live_button(true, area(0.0, 12.0));
    let visibility = VisibilityEvidence {
        bounds: live.bounds,
        states: live.state.states.clone(),
        bounds_from_live: true,
        states_from_live: true,
    };
    assert!(visibility.applicable());
    assert!(!visibility.result());
}

#[test]
fn occluded_headed_reports_receives_events_fail_with_occluder() {
    let adapter = EnvelopeAdapter::new(live_button(true, area(40.0, 20.0))).occluded("sheet");
    let error = click(
        &adapter,
        ActionRequest::headed(Action::Click).with_timeout_ms(Some(0)),
    );
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_not_delivered(&error);
    let details = error.details.expect("occlusion details");
    let check = find_check(&details, "receives_events");
    assert_eq!(check["status"], "fail");
    assert_eq!(check["reason"], "occluded by sheet");
    assert_eq!(check["occluder"]["role"], "sheet");
    assert_eq!(check["occluder"]["name"], "cover");
    assert!(check["occluder"]["bounds"].is_object());
    assert!(!error.message.contains("cover"));
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn unoccluded_headed_passes_gate_then_platform_not_supported() {
    let adapter = EnvelopeAdapter::new(live_button(true, area(40.0, 20.0)));
    let error = click(
        &adapter,
        ActionRequest::headed(Action::Click).with_timeout_ms(Some(0)),
    );
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert_not_delivered(&error);
    assert!(
        error.message.contains("execute_action"),
        "gate ordering proof: dispatch trait default, not actionability"
    );
}

#[test]
fn occluded_headed_auto_wait_reports_receives_events_without_timing_out() {
    let adapter = EnvelopeAdapter::new(live_button(true, area(40.0, 20.0))).occluded("window");
    let error = click(
        &adapter,
        ActionRequest::headed(Action::Click).with_timeout_ms(Some(80)),
    );
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_not_delivered(&error);
    let details = error.details.expect("occlusion details");
    let check = find_check(&details, "receives_events");
    assert_eq!(check["status"], "fail");
    assert_eq!(check["reason"], "occluded by window");
    assert_eq!(check["occluder"]["role"], "window");
}
