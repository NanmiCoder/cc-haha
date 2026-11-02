use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AdapterError, ErrorCode, Rect,
    actions::action::Action,
    actions::action_request::ActionRequest,
    actions::capability,
    adapter::{LiveElement, NativeHandle, SnapshotSurface},
    refs::RefEntry,
    tree::element_state::ElementState,
};

struct LiveAdapter {
    state: Option<ElementState>,
    bounds: Option<Rect>,
    actions: Option<Vec<String>>,
}

impl ObservationOps for LiveAdapter {
    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<LiveElement, AdapterError> {
        Ok(LiveElement {
            identity: crate::adapter::live_identity("OK"),
            state: self.state.clone().unwrap_or_else(|| ElementState {
                role: "button".into(),
                states: Vec::new(),
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            }),
            states_complete: true,
            bounds: self.bounds,
            available_actions: self.actions.clone().unwrap_or_default(),
        })
    }

    fn get_live_state(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        Ok(self.state.clone())
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Ok(self.bounds)
    }

    fn get_live_actions(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Vec<String>>, AdapterError> {
        Ok(self.actions.clone())
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

impl ActionOps for LiveAdapter {}

impl InputOps for LiveAdapter {}

impl SystemOps for LiveAdapter {}

struct CombinedLiveAdapter;

impl ObservationOps for CombinedLiveAdapter {
    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<LiveElement, AdapterError> {
        Ok(LiveElement {
            identity: crate::adapter::live_identity("OK"),
            state: ElementState {
                role: "button".into(),
                states: vec![],
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: Some(Rect {
                x: 1.0,
                y: 1.0,
                width: 20.0,
                height: 20.0,
            }),
            available_actions: vec![capability::CLICK.into()],
        })
    }

    fn get_live_state(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        panic!("check_live should use get_live_element")
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        panic!("check_live should use get_live_element")
    }

    fn get_live_actions(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Vec<String>>, AdapterError> {
        panic!("check_live should use get_live_element")
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

impl ActionOps for CombinedLiveAdapter {}

impl InputOps for CombinedLiveAdapter {}

impl SystemOps for CombinedLiveAdapter {}

struct LiveReadErrorAdapter;

impl ObservationOps for LiveReadErrorAdapter {
    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<LiveElement, AdapterError> {
        Err(AdapterError::permission_denied())
    }

    fn get_live_state(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        Err(AdapterError::permission_denied())
    }
}

impl ActionOps for LiveReadErrorAdapter {}

impl InputOps for LiveReadErrorAdapter {}

impl SystemOps for LiveReadErrorAdapter {}

struct UnsupportedLiveAdapter;

impl ObservationOps for UnsupportedLiveAdapter {}

impl ActionOps for UnsupportedLiveAdapter {}

impl InputOps for UnsupportedLiveAdapter {}

impl SystemOps for UnsupportedLiveAdapter {}

struct DeadLiveElementAdapter;

impl ObservationOps for DeadLiveElementAdapter {
    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<LiveElement, AdapterError> {
        Ok(LiveElement {
            identity: crate::adapter::live_identity("OK"),
            state: ElementState {
                role: "unknown".into(),
                states: vec![],
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: None,
            available_actions: vec![],
        })
    }
}

impl ActionOps for DeadLiveElementAdapter {}

impl InputOps for DeadLiveElementAdapter {}

impl SystemOps for DeadLiveElementAdapter {}

fn entry() -> RefEntry {
    let bounds = Rect {
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
            name: Some("OK".into()),
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
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: true,
            path: smallvec::SmallVec::new(),
        },
    }
}

#[test]
fn live_actionability_overrides_stale_snapshot_state() {
    let mut stale = entry();
    stale.capabilities.states.push("disabled".into());
    let adapter = LiveAdapter {
        state: Some(ElementState {
            role: "button".into(),
            states: vec![],
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        }),
        bounds: stale.geometry.bounds,
        actions: Some(vec![capability::CLICK.into()]),
    };

    let report = check_live(
        &stale,
        &NativeHandle::null(),
        &adapter,
        &ActionRequest::headless(Action::Click),
    )
    .unwrap();

    assert!(report.actionable);
}

#[test]
fn live_actionability_uses_combined_live_element_read() {
    let mut stale = entry();
    stale.capabilities.states.push("disabled".into());
    stale.geometry.bounds = Some(Rect {
        x: 1.0,
        y: 1.0,
        width: 0.0,
        height: 20.0,
    });
    stale.capabilities.available_actions = vec![];

    let report = check_live(
        &stale,
        &NativeHandle::null(),
        &CombinedLiveAdapter,
        &ActionRequest::headless(Action::Click),
    )
    .unwrap();

    assert!(report.actionable);
}

#[test]
fn live_actionability_uses_actions_gained_after_snapshot() {
    let mut stale = entry();
    stale.capabilities.available_actions = vec![];
    let adapter = LiveAdapter {
        state: Some(ElementState {
            role: "button".into(),
            states: vec![],
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        }),
        bounds: stale.geometry.bounds,
        actions: Some(vec![capability::CLICK.into()]),
    };

    let report = check_live(
        &stale,
        &NativeHandle::null(),
        &adapter,
        &ActionRequest::headless(Action::Click),
    )
    .unwrap();

    assert!(report.actionable);
}

#[test]
fn live_actionability_fails_when_action_disappears_after_snapshot() {
    let stale = entry();
    let adapter = LiveAdapter {
        state: None,
        bounds: stale.geometry.bounds,
        actions: Some(vec![capability::SET_VALUE.into()]),
    };

    let err = check_live(
        &stale,
        &NativeHandle::null(),
        &adapter,
        &ActionRequest::headless(Action::Click),
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::PolicyDenied);
    assert!(err.message.contains("supported_action"));
}

#[test]
fn live_actionability_rejects_unstable_identity_resolved_bounds_change() {
    let stale = entry();
    let adapter = LiveAdapter {
        state: None,
        bounds: Some(Rect {
            x: 100.0,
            y: 100.0,
            width: 20.0,
            height: 20.0,
        }),
        actions: Some(vec![capability::CLICK.into()]),
    };

    let err = check_live(
        &stale,
        &NativeHandle::null(),
        &adapter,
        &ActionRequest::headed(Action::DoubleClick),
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::ActionFailed);
    assert!(err.message.contains("stable"));
}

#[path = "actionability_semantic_geometry_tests.rs"]
mod semantic_geometry_tests;

#[path = "actionability_live_failure_tests.rs"]
mod failure_tests;
