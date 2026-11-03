use crate::{
    Action, ActionOps, ActionRequest, ActionResult, AdapterError, Deadline, ElementState, InputOps,
    InteractionLease, LiveElement, NativeHandle, ObservationOps, RefEntry, SystemOps, WindowInfo,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct FocusAdapter {
    focused: AtomicBool,
    dispatched: AtomicUsize,
    persistent_occlusion: bool,
    enabled: bool,
}

fn bounds() -> crate::Rect {
    crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    }
}

impl FocusAdapter {
    fn live_bounds(&self) -> crate::Rect {
        crate::Rect {
            x: if self.focused.load(Ordering::SeqCst) {
                100.0
            } else {
                1.0
            },
            ..bounds()
        }
    }
}

impl ObservationOps for FocusAdapter {
    fn resolve_element_strict(
        &self,
        _: &RefEntry,
        _: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_live_element(&self, _: &NativeHandle, _: Deadline) -> Result<LiveElement, AdapterError> {
        Ok(LiveElement {
            identity: crate::adapter::live_identity("Run"),
            state: ElementState {
                role: "button".into(),
                states: vec![],
                value: None,
                enabled: Some(self.enabled),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: Some(self.live_bounds()),
            available_actions: vec![crate::actions::capability::CLICK.into()],
        })
    }

    fn get_element_bounds(
        &self,
        _: &NativeHandle,
        _: Deadline,
    ) -> Result<Option<crate::Rect>, AdapterError> {
        Ok(Some(self.live_bounds()))
    }

    fn hit_test(
        &self,
        _: &NativeHandle,
        _: crate::Point,
        _: Deadline,
    ) -> Result<crate::HitTestResult, AdapterError> {
        Ok(
            if self.focused.load(Ordering::SeqCst) && !self.persistent_occlusion {
                crate::HitTestResult::ReachesTarget
            } else {
                crate::HitTestResult::InterceptedBy {
                    role: Some("window".into()),
                    name: None,
                    bounds: None,
                }
            },
        )
    }
}

impl ActionOps for FocusAdapter {
    fn execute_action(
        &self,
        _: &NativeHandle,
        request: ActionRequest,
        _: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        if request.policy.is_headed() {
            assert!(self.focused.load(Ordering::SeqCst));
            assert_eq!(request.verified_point().map(|point| point.x), Some(110.0));
        }
        self.dispatched.fetch_add(1, Ordering::SeqCst);
        Ok(ActionResult::delivered_unverified("click"))
    }
}
impl InputOps for FocusAdapter {}
impl SystemOps for FocusAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn resolve_window_strict(
        &self,
        window: &WindowInfo,
        _: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        Ok(window.clone())
    }
    fn focus_window(&self, _: &WindowInfo, _: &InteractionLease) -> Result<(), AdapterError> {
        self.focused.store(true, Ordering::SeqCst);
        Ok(())
    }
}

fn execute(adapter: &FocusAdapter, headed: bool) -> Result<ActionResult, AdapterError> {
    execute_within(adapter, headed, 2_000)
}

fn execute_within(
    adapter: &FocusAdapter,
    headed: bool,
    timeout_ms: u64,
) -> Result<ActionResult, AdapterError> {
    let _clock = crate::wait::deadline::VirtualClock::freeze();
    let entry: RefEntry = serde_json::from_value(serde_json::json!({
        "pid": 1, "process_instance": "test-instance", "role": "button", "name": "Run",
        "source_window_id": "w-test", "source_surface": "window", "path": [0],
        "bounds": bounds(), "bounds_hash": bounds().bounds_hash(), "available_actions": ["Click"], "states": []
    })).unwrap();
    let request = if headed {
        ActionRequest::headed(Action::Click)
    } else {
        ActionRequest::headless(Action::Click)
    };
    crate::ref_action::execute_entry(adapter, &entry, request.with_timeout_ms(Some(timeout_ms)))
}

fn adapter(persistent_occlusion: bool, enabled: bool) -> FocusAdapter {
    FocusAdapter {
        focused: AtomicBool::new(false),
        dispatched: AtomicUsize::new(0),
        persistent_occlusion,
        enabled,
    }
}

#[test]
fn headed_background_target_is_focused_before_final_hit_test_and_dispatch() {
    let adapter = adapter(false, true);
    execute(&adapter, true).unwrap();
    assert!(adapter.focused.load(Ordering::SeqCst));
    assert_eq!(adapter.dispatched.load(Ordering::SeqCst), 1);
}

#[test]
fn headed_target_still_occluded_after_focus_never_receives_input() {
    let adapter = adapter(true, true);
    execute(&adapter, true).unwrap_err();
    assert!(adapter.focused.load(Ordering::SeqCst));
    assert_eq!(adapter.dispatched.load(Ordering::SeqCst), 0);
}

#[test]
fn disabled_target_does_not_trigger_early_focus() {
    let adapter = adapter(false, false);
    execute_within(&adapter, true, 150).unwrap_err();
    assert!(!adapter.focused.load(Ordering::SeqCst));
    assert_eq!(adapter.dispatched.load(Ordering::SeqCst), 0);
}

#[test]
fn headless_semantic_action_never_raises_the_window() {
    let adapter = adapter(false, true);
    execute(&adapter, false).unwrap();
    assert!(!adapter.focused.load(Ordering::SeqCst));
    assert_eq!(adapter.dispatched.load(Ordering::SeqCst), 1);
}
