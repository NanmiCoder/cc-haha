use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AdapterError, Rect, adapter::NativeHandle, refs::RefMap, refs::refs_store::RefStore,
    refs::refs_test_support::HomeGuard, tree::state,
};
use std::sync::Mutex;

struct LiveStateAdapter {
    state: Mutex<Option<ElementState>>,
    bounds: Mutex<Option<Rect>>,
    bounds_supported: bool,
    state_supported: bool,
}

impl LiveStateAdapter {
    fn with_live(bounds: Rect, states: Vec<String>) -> Self {
        Self {
            state: Mutex::new(Some(ElementState {
                role: "button".into(),
                states,
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            })),
            bounds: Mutex::new(Some(bounds)),
            bounds_supported: true,
            state_supported: true,
        }
    }

    fn without_live_support() -> Self {
        Self {
            state: Mutex::new(None),
            bounds: Mutex::new(None),
            bounds_supported: false,
            state_supported: false,
        }
    }
}

impl ObservationOps for LiveStateAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_live_state(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        if !self.state_supported {
            return Err(AdapterError::not_supported("get_live_state"));
        }
        Ok(self.state.lock().unwrap().clone())
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        if !self.bounds_supported {
            return Err(AdapterError::not_supported("get_element_bounds"));
        }
        Ok(*self.bounds.lock().unwrap())
    }
}

impl ActionOps for LiveStateAdapter {}

impl InputOps for LiveStateAdapter {}

impl SystemOps for LiveStateAdapter {}

fn save_entry(entry: RefEntry) -> String {
    let mut refmap = RefMap::new();
    refmap.allocate(entry);
    RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap()
}

fn entry(states: Vec<String>, value: Option<&str>, actions: Vec<&str>) -> RefEntry {
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "checkbox".into(),
            name: Some("Target".into()),
            value: value.map(str::to_string),
            description: None,
            native_id: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash: None,
        },
        capabilities: crate::RefCapabilities {
            states,
            available_actions: actions.into_iter().map(str::to_string).collect(),
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
    }
}

fn visible_bounds() -> Rect {
    Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    }
}

#[test]
fn hidden_element_reports_not_visible() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry(vec![], None, vec![]));
    let adapter = LiveStateAdapter::with_live(visible_bounds(), vec![state::HIDDEN.into()]);

    let result = execute(
        IsArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: IsProperty::Visible,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(result["result"], false);
    assert_eq!(result["applicable"], true);
}

#[test]
fn zero_sized_bounds_report_not_visible() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry(vec![], None, vec![]));
    let adapter = LiveStateAdapter::with_live(
        Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 10.0,
        },
        vec![],
    );

    let result = execute(
        IsArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: IsProperty::Visible,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(result["result"], false);
    assert_eq!(result["applicable"], true);
}

#[test]
fn offscreen_element_reports_not_visible() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry(vec![], None, vec![]));
    let adapter = LiveStateAdapter::with_live(visible_bounds(), vec![state::OFFSCREEN.into()]);

    let result = execute(
        IsArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: IsProperty::Visible,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(result["result"], false);
    assert_eq!(result["applicable"], true);
}

#[test]
fn visible_element_with_live_evidence_reports_true() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry(vec![], None, vec![]));
    let adapter = LiveStateAdapter::with_live(visible_bounds(), vec![]);

    let result = execute(
        IsArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: IsProperty::Visible,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(result["result"], true);
    assert_eq!(result["applicable"], true);
}

#[test]
fn visible_degrades_applicability_when_live_reads_unsupported() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry(vec![], None, vec![]));
    let adapter = LiveStateAdapter::without_live_support();

    let result = execute(
        IsArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: IsProperty::Visible,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(result["result"], false);
    assert_eq!(result["applicable"], false);
}

#[test]
fn checked_uses_live_canonical_state() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry(vec![], None, vec!["Toggle"]));
    let adapter = LiveStateAdapter {
        state: Mutex::new(Some(ElementState {
            role: "checkbox".into(),
            states: vec!["checked".into()],
            value: Some("1".into()),
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        })),
        bounds: Mutex::new(None),
        bounds_supported: false,
        state_supported: true,
    };

    let result = execute(
        IsArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: IsProperty::Checked,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(result["result"], true);
    assert_eq!(result["applicable"], true);
}

#[test]
fn checked_does_not_infer_platform_values_in_core() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry(vec![], Some("1"), vec!["Toggle"]));
    let adapter = LiveStateAdapter {
        state: Mutex::new(None),
        bounds: Mutex::new(None),
        bounds_supported: false,
        state_supported: true,
    };

    let result = execute(
        IsArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: IsProperty::Checked,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(result["result"], false);
    assert_eq!(result["applicable"], true);
}

#[test]
fn checked_falls_back_to_snapshot_state_when_live_state_is_missing() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry(vec!["checked".into()], None, vec!["Toggle"]));
    let adapter = LiveStateAdapter {
        state: Mutex::new(None),
        bounds: Mutex::new(None),
        bounds_supported: false,
        state_supported: true,
    };

    let result = execute(
        IsArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: IsProperty::Checked,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(result["result"], true);
    assert_eq!(result["applicable"], true);
}

#[test]
fn basic_state_properties_use_live_state() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry(vec![], None, vec![]));
    let adapter = LiveStateAdapter::with_live(
        visible_bounds(),
        vec!["focused".into(), "expanded".into(), "selected".into()],
    );

    for (property, expected) in [
        (IsProperty::Enabled, true),
        (IsProperty::Focused, true),
        (IsProperty::Expanded, true),
        (IsProperty::Selected, true),
    ] {
        let result = execute(
            IsArgs {
                ref_id: format!("@{}:e1", snapshot_id.clone()),
                property,
            },
            &adapter,
            &CommandContext::default(),
        )
        .unwrap();

        assert_eq!(result["result"], expected);
        assert_eq!(result["applicable"], true);
    }
}

#[path = "is_check_applicability_tests.rs"]
mod applicability_tests;

#[path = "is_check_vocabulary_tests.rs"]
mod vocabulary_tests;

#[path = "get_consistency_tests.rs"]
mod get_consistency_tests;

fn visible_without_bounds_result(offscreen: Option<bool>) -> Value {
    let snapshot_id = save_entry(entry(vec![], None, vec![]));
    let adapter = LiveStateAdapter::with_live(visible_bounds(), vec![]);
    *adapter.bounds.lock().unwrap() = None;
    adapter.state.lock().unwrap().as_mut().unwrap().offscreen = offscreen;
    execute(
        IsArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: IsProperty::Visible,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap()
}

#[test]
fn visible_without_bounds_agrees_with_the_gate_when_offscreen_is_known_false() {
    let _guard = HomeGuard::new();
    let result = visible_without_bounds_result(Some(false));

    assert_eq!(result["result"], true);
    assert_eq!(result["applicable"], true);
}

#[test]
fn visible_without_bounds_stays_inapplicable_when_offscreen_is_unknown() {
    let _guard = HomeGuard::new();
    let result = visible_without_bounds_result(None);

    assert_eq!(result["result"], false);
    assert_eq!(result["applicable"], false);
}
