use crate::adapter::hit_test::HitTestResult;
use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::commands::{drag, hover};
use crate::refs::refs_store::RefStore;
use crate::refs::refs_test_support::HomeGuard;
use crate::refs::{RefEntry, RefMap};
use crate::{
    AdapterError, AppError, CommandContext, DeliverySemantics, DragParams, InteractionLease,
    MouseEvent, Point, ProcessId, Rect,
};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

#[derive(Default)]
struct PointerReadCounts {
    scrolls: AtomicU32,
    resolves: AtomicU32,
    observations: AtomicU32,
}

struct SingleShotScrollAdapter {
    scrolled: AtomicBool,
    reads: PointerReadCounts,
    leases: AtomicU32,
    mouse_moves: AtomicU32,
    drags: AtomicU32,
    mouse_point: Mutex<Option<Point>>,
    drag_params: Mutex<Option<DragParams>>,
    scroll_fails: bool,
    move_fails: bool,
}

impl SingleShotScrollAdapter {
    fn new() -> Self {
        Self {
            scrolled: AtomicBool::new(false),
            reads: PointerReadCounts::default(),
            leases: AtomicU32::new(0),
            mouse_moves: AtomicU32::new(0),
            drags: AtomicU32::new(0),
            mouse_point: Mutex::new(None),
            drag_params: Mutex::new(None),
            scroll_fails: false,
            move_fails: false,
        }
    }
}

fn uncertain_timeout() -> AdapterError {
    AdapterError::timeout("delivered then ran out of time")
        .with_disposition(DeliverySemantics::uncertain())
}

impl ObservationOps for SingleShotScrollAdapter {
    fn observe_pointer(
        &self,
        handle: &NativeHandle,
        deadline: crate::Deadline,
    ) -> Result<crate::PointerObservation, AdapterError> {
        self.reads.observations.fetch_add(1, Ordering::SeqCst);
        Ok(crate::PointerObservation {
            bounds: self.get_element_bounds(handle, deadline)?,
            states: Vec::new(),
        })
    }
    fn resolve_element_strict(
        &self,
        entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.reads.resolves.fetch_add(1, Ordering::SeqCst);
        Ok(NativeHandle::new(entry.process.pid.get()))
    }

    fn get_element_bounds(
        &self,
        handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        let pid = *handle.downcast_ref::<u32>().unwrap();
        if pid == 1 && !self.scrolled.load(Ordering::SeqCst) {
            return Ok(None);
        }
        Ok(Some(Rect {
            x: f64::from(pid) * 100.0,
            y: f64::from(pid) * 200.0,
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
        Ok(HitTestResult::ReachesTarget)
    }
}

impl ActionOps for SingleShotScrollAdapter {
    fn scroll_into_view(
        &self,
        handle: &NativeHandle,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        assert_eq!(*handle.downcast_ref::<u32>().unwrap(), 1);
        self.reads.scrolls.fetch_add(1, Ordering::SeqCst);
        self.scrolled.store(true, Ordering::SeqCst);
        if self.scroll_fails {
            return Err(uncertain_timeout());
        }
        Ok(())
    }
}

impl InputOps for SingleShotScrollAdapter {
    fn mouse_event(
        &self,
        event: MouseEvent,
        _lease: &InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        self.mouse_moves.fetch_add(1, Ordering::SeqCst);
        *self.mouse_point.lock().unwrap() = Some(event.point);
        if self.move_fails {
            return Err(uncertain_timeout());
        }
        Ok(crate::adapter::test_report())
    }

    fn drag(
        &self,
        params: DragParams,
        _lease: &InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        self.drags.fetch_add(1, Ordering::SeqCst);
        *self.drag_params.lock().unwrap() = Some(params);
        Ok(crate::adapter::test_report())
    }
}

impl SystemOps for SingleShotScrollAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        self.leases.fetch_add(1, Ordering::SeqCst);
        InteractionLease::guarded(deadline, ())
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
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        Ok(())
    }
}

fn ref_entry(pid: u32) -> RefEntry {
    RefEntry {
        process: crate::RefProcess {
            pid: ProcessId::new(pid),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some(format!("Target {pid}")),
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
            states: Vec::new(),
            available_actions: vec![crate::actions::capability::CLICK.into()],
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

fn snapshot(refs: u32) -> String {
    let store = RefStore::new().unwrap();
    let mut refmap = RefMap::new();
    for pid in 1..=refs {
        refmap.allocate(ref_entry(pid));
    }
    store.save_new_snapshot(&refmap).unwrap()
}

#[test]
fn hover_none_scrolls_once_then_dispatches_stable_point_once() {
    let _guard = HomeGuard::new();
    let adapter = SingleShotScrollAdapter::new();
    let value = hover::execute(
        hover::HoverArgs {
            ref_id: Some(format!("@{}:e1", snapshot(1))),
            xy: None,
            duration_ms: None,
            timeout_ms: None,
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert_eq!(adapter.reads.scrolls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.leases.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.reads.resolves.load(Ordering::SeqCst), 3);
    assert_eq!(adapter.mouse_moves.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.reads.observations.load(Ordering::SeqCst), 3);
    assert_eq!(value["x"], 110.0);
    assert_eq!(value["y"], 205.0);
}

#[test]
fn drag_none_scrolls_once_then_dispatches_revalidated_endpoints_once() {
    let _guard = HomeGuard::new();
    let adapter = SingleShotScrollAdapter::new();
    let value = drag::execute(
        drag::DragArgs {
            from: drag::DragEndpoint {
                ref_id: Some(format!("@{}:e1", snapshot(2))),
                xy: None,
            },
            to: drag::DragEndpoint {
                ref_id: Some(format!("@{}:e2", snapshot(2))),
                xy: None,
            },
            duration_ms: None,
            drop_delay_ms: None,
            timeout_ms: None,
            wait_for_scope: drag::WaitForScope::default(),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert_eq!(adapter.reads.scrolls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.leases.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.reads.resolves.load(Ordering::SeqCst), 5);
    assert_eq!(adapter.drags.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.reads.observations.load(Ordering::SeqCst), 5);
    assert_eq!(value["from"], serde_json::json!({ "x": 110.0, "y": 205.0 }));
    assert_eq!(value["to"], serde_json::json!({ "x": 210.0, "y": 405.0 }));
}

fn hover_args(timeout_ms: Option<u64>) -> hover::HoverArgs {
    hover::HoverArgs {
        ref_id: Some(format!("@{}:e1", snapshot(1))),
        xy: None,
        duration_ms: None,
        timeout_ms,
    }
}

fn drag_args(timeout_ms: Option<u64>) -> drag::DragArgs {
    let snapshot_id = snapshot(2);
    drag::DragArgs {
        from: drag::DragEndpoint {
            ref_id: Some(format!("@{snapshot_id}:e1")),
            xy: None,
        },
        to: drag::DragEndpoint {
            ref_id: Some(format!("@{snapshot_id}:e2")),
            xy: None,
        },
        duration_ms: None,
        drop_delay_ms: None,
        timeout_ms,
        wait_for_scope: drag::WaitForScope::default(),
    }
}

fn disposition(error: AppError) -> DeliverySemantics {
    match error {
        AppError::Adapter(error) => error.disposition,
        other => panic!("expected an adapter error, got {other:?}"),
    }
}

#[test]
fn a_scroll_that_fails_before_the_first_pointer_event_leaves_the_gesture_undelivered() {
    let headed = CommandContext::default().with_headed(true);
    for timeout_ms in [None, Some(5_000)] {
        let _guard = HomeGuard::new();
        let mut hovered = SingleShotScrollAdapter::new();
        hovered.scroll_fails = true;
        let error = hover::execute(hover_args(timeout_ms), &hovered, &headed).unwrap_err();
        assert_eq!(disposition(error), DeliverySemantics::not_delivered());
        assert_eq!(hovered.mouse_moves.load(Ordering::SeqCst), 0);
        let mut dragged = SingleShotScrollAdapter::new();
        dragged.scroll_fails = true;
        let error = drag::execute(drag_args(timeout_ms), &dragged, &headed).unwrap_err();
        assert_eq!(disposition(error), DeliverySemantics::not_delivered());
        assert_eq!(dragged.drags.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn a_failure_after_the_pointer_event_started_keeps_its_own_disposition() {
    let _guard = HomeGuard::new();
    let mut adapter = SingleShotScrollAdapter::new();
    adapter.move_fails = true;
    let error = hover::execute(
        hover_args(None),
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();
    assert_eq!(disposition(error), DeliverySemantics::uncertain());
    assert_eq!(adapter.mouse_moves.load(Ordering::SeqCst), 1);
}
