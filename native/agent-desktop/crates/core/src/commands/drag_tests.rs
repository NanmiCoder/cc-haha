use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AdapterError, CursorOverlayControl, DeliverySemantics, DragParams, Rect,
    actions::capability,
    adapter::NativeHandle,
    adapter::hit_test::HitTestResult,
    commands::stale_retry_test_support::StaleRetryCounter,
    refs::refs_store::RefStore,
    refs::refs_test_support::HomeGuard,
    refs::{RefEntry, RefMap},
};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
#[path = "drag_timing_tests.rs"]
mod timing_tests;

struct DragCaptureAdapter {
    captured: Mutex<Option<DragParams>>,
    presented: Mutex<Vec<CursorOverlayControl>>,
    focused_pids: Mutex<Vec<crate::ProcessId>>,
    resolve_calls: AtomicU32,
    presented_before_drag: AtomicU32,
    focused_bounds: Option<Rect>,
    drag_failure: Option<DeliverySemantics>,
    drag_report: Option<crate::OperationReport>,
}

impl DragCaptureAdapter {
    fn new() -> Self {
        Self {
            captured: Mutex::new(None),
            presented: Mutex::new(Vec::new()),
            focused_pids: Mutex::new(Vec::new()),
            resolve_calls: AtomicU32::new(0),
            presented_before_drag: AtomicU32::new(0),
            focused_bounds: None,
            drag_failure: None,
            drag_report: None,
        }
    }

    fn with_focused_bounds(mut self, bounds: Rect) -> Self {
        self.focused_bounds = Some(bounds);
        self
    }

    fn with_drag_report(mut self, report: crate::OperationReport) -> Self {
        self.drag_report = Some(report);
        self
    }

    fn with_drag_failure(mut self, disposition: DeliverySemantics) -> Self {
        self.drag_failure = Some(disposition);
        self
    }
}

impl ObservationOps for DragCaptureAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        Ok(NativeHandle::null())
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        if !self.focused_pids.lock().unwrap().is_empty()
            && let Some(bounds) = self.focused_bounds
        {
            return Ok(Some(bounds));
        }
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

impl ActionOps for DragCaptureAdapter {}

impl InputOps for DragCaptureAdapter {
    fn drag(
        &self,
        params: DragParams,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        self.presented_before_drag.store(
            self.presented.lock().unwrap().len() as u32,
            Ordering::SeqCst,
        );
        *self.captured.lock().unwrap() = Some(params);
        if let Some(disposition) = self.drag_failure {
            return Err(AdapterError::internal("drag completion was uncertain")
                .with_disposition(disposition));
        }
        Ok(self
            .drag_report
            .clone()
            .unwrap_or_else(crate::adapter::test_report))
    }
}

impl SystemOps for DragCaptureAdapter {
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
        window: &crate::WindowInfo,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        self.focused_pids.lock().unwrap().push(window.pid);
        Ok(())
    }

    fn update_cursor_overlay(&self, control: &CursorOverlayControl) -> Result<(), AdapterError> {
        self.presented.lock().unwrap().push(control.clone());
        Ok(())
    }
}

fn xy_args(drop_delay_ms: Option<u64>) -> DragArgs {
    DragArgs {
        from: DragEndpoint {
            ref_id: None,
            xy: Some((1.0, 2.0)),
        },
        to: DragEndpoint {
            ref_id: None,
            xy: Some((3.0, 4.0)),
        },
        duration_ms: None,
        drop_delay_ms,
        timeout_ms: None,
        wait_for_scope: WaitForScope::default(),
    }
}

#[test]
fn drop_delay_is_threaded_into_drag_params_and_response() {
    let adapter = DragCaptureAdapter::new();

    let value = execute(
        xy_args(Some(750)),
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert!(value.get("dragged").is_none());
    assert_eq!(value["drop_delay_ms"], 750);
    let captured = adapter.captured.lock().unwrap().clone().unwrap();
    assert_eq!(captured.drop_delay_ms, Some(750));
    assert_eq!((captured.from.x, captured.from.y), (1.0, 2.0));
    assert_eq!((captured.to.x, captured.to.y), (3.0, 4.0));
}

#[test]
fn drop_delay_omitted_uses_adapter_default_and_no_response_field() {
    let adapter = DragCaptureAdapter::new();

    let value = execute(
        xy_args(None),
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert!(value.get("drop_delay_ms").is_none());
    let captured = adapter.captured.lock().unwrap().clone().unwrap();
    assert_eq!(captured.drop_delay_ms, None);
}

#[test]
fn successful_drag_effect_carries_the_complete_path() {
    let adapter = DragCaptureAdapter::new();
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    let context = CommandContext::default()
        .with_headed(true)
        .with_cursor_overlay_session("test-session", config);

    execute(xy_args(None), &adapter, &context).expect("drag succeeds");

    let presented = adapter.presented.lock().unwrap();
    assert_eq!(adapter.presented_before_drag.load(Ordering::SeqCst), 2);
    assert_eq!(
        presented[1]
            .instruction()
            .expect("drag instruction")
            .phase(),
        crate::CursorPhase::Drag
    );
    let effect = presented
        .last()
        .and_then(CursorOverlayControl::instruction)
        .expect("effect instruction");
    assert_eq!(effect.phase(), crate::CursorPhase::Effect);
    assert_eq!(effect.drag_from(), Some(&crate::Point { x: 1.0, y: 2.0 }));
    assert_eq!(effect.destination(), &crate::Point { x: 3.0, y: 4.0 });
}

#[test]
fn uncertain_drag_hides_the_overlay_without_claiming_a_landing() {
    let adapter = DragCaptureAdapter::new().with_drag_failure(DeliverySemantics::uncertain());
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    let context = CommandContext::default()
        .with_agent_id(Some("agent-a".into()))
        .expect("valid agent")
        .with_headed(true)
        .with_cursor_overlay_session("test-session", config);

    execute(xy_args(None), &adapter, &context).expect_err("drag is uncertain");

    let presented = adapter.presented.lock().unwrap();
    let cancel = presented.last().expect("cancel control");
    assert!(cancel.is_hide());
    assert!(cancel.instruction().is_none());
    assert_eq!(cancel.agent_id(), None);
}

#[test]
fn expired_action_deadline_does_not_suppress_drag_cancellation() {
    let adapter = DragCaptureAdapter::new();
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    let context = CommandContext::default()
        .with_headed(true)
        .with_cursor_overlay_session("test-session", config);
    let expired = crate::Deadline::detached_after(1).expect("valid deadline");
    std::thread::sleep(std::time::Duration::from_millis(2));
    let _scope = crate::wait::deadline::enter_scope(Some(expired));

    crate::cursor_overlay::cancel_drag(&adapter, &context);

    assert!(adapter.presented.lock().unwrap()[0].is_hide());
}

fn ref_entry(pid: u32) -> RefEntry {
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(pid),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some("Item".into()),
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
            source_app: Some(format!("App {pid}")),
            source_window_id: Some(format!("w-{pid}")),
            source_window_title: Some(format!("Window {pid}")),
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

fn cross_app_snapshot() -> String {
    let store = RefStore::new().unwrap();
    let mut refmap = RefMap::new();
    refmap.allocate(ref_entry(1));
    refmap.allocate(ref_entry(2));
    store.save_new_snapshot(&refmap).unwrap()
}

fn cross_app_args(snapshot_id: String) -> DragArgs {
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
    }
}

#[test]
fn headless_ref_drag_is_policy_denied_before_cursor_move() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    let adapter = DragCaptureAdapter::new();

    let err = execute(
        cross_app_args(snapshot_id),
        &adapter,
        &CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "POLICY_DENIED");
    assert!(adapter.focused_pids.lock().unwrap().is_empty());
    assert!(adapter.captured.lock().unwrap().is_none());
}

#[test]
fn headed_ref_drag_focuses_only_the_from_app_once() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    let adapter = DragCaptureAdapter::new().with_focused_bounds(Rect {
        x: 100.0,
        y: 200.0,
        width: 40.0,
        height: 60.0,
    });

    let value = execute(
        cross_app_args(snapshot_id),
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert_eq!(*adapter.focused_pids.lock().unwrap(), vec![1]);
    let captured = adapter.captured.lock().unwrap().clone().unwrap();
    assert_eq!((captured.from.x, captured.from.y), (120.0, 230.0));
    assert_eq!(value["focused"], true);
}

#[test]
fn positive_timeout_uses_stable_post_focus_drag_bounds() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    let adapter = DragCaptureAdapter::new().with_focused_bounds(Rect {
        x: 100.0,
        y: 200.0,
        width: 40.0,
        height: 60.0,
    });
    let mut args = cross_app_args(snapshot_id);
    args.timeout_ms = Some(5_000);

    let value = execute(args, &adapter, &CommandContext::default().with_headed(true)).unwrap();

    assert_eq!(*adapter.focused_pids.lock().unwrap(), vec![1]);
    assert_eq!(value["from"], json!({ "x": 120.0, "y": 230.0 }));
    assert_eq!(value["to"], json!({ "x": 120.0, "y": 230.0 }));
}

#[path = "drag_retry_tests.rs"]
mod retry_tests;

#[path = "drag_occlusion_retry_tests.rs"]
mod occlusion_retry_tests;

#[path = "drag_wait_scope_tests.rs"]
mod wait_scope_tests;

#[path = "drag_overlay_report_tests.rs"]
mod overlay_report_tests;
