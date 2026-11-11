use super::*;
use crate::adapter::TreeOptions;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AdapterError, ErrorCode, WindowInfo,
    actions::action_request::ActionRequest,
    actions::action_result::ActionResult,
    adapter::{NativeHandle, WindowFilter},
    refs::refs_store::RefStore,
    refs::refs_test_support::HomeGuard,
    refs::{RefEntry, RefMap},
};

struct ProbeFailingAdapter {
    tree_error: Option<ErrorCode>,
}

impl ObservationOps for ProbeFailingAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn list_windows(
        &self,
        filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        if filter.app.is_some() && self.tree_error.is_none() {
            return Err(AdapterError::new(
                ErrorCode::WindowNotFound,
                "menu probe failed",
            ));
        }
        if filter.focused_only {
            return Err(AdapterError::new(
                ErrorCode::WindowNotFound,
                "no focused menu",
            ));
        }
        Ok(vec![WindowInfo {
            id: "w1".into(),
            title: "Main".into(),
            app: "TargetApp".into(),
            pid: crate::ProcessId::new(7),
            process_instance: Some("test-instance".into()),
            bounds: None,
            state: crate::WindowState {
                is_focused: true,
                ..Default::default()
            },
        }])
    }

    fn get_tree(
        &self,
        _win: &WindowInfo,
        _opts: &TreeOptions,
        _deadline: crate::Deadline,
    ) -> Result<crate::AccessibilityNode, AdapterError> {
        if let Some(code) = self.tree_error.clone() {
            return Err(AdapterError::new(code, "menu tree unavailable"));
        }
        Ok(crate::AccessibilityNode {
            ref_id: None,
            role: "menu".into(),
            identity: Default::default(),
            presentation: Default::default(),
            children_count: None,
            subtree_truncated: false,
            children: Vec::new(),
        })
    }

    crate::adapter::complete_live_observation!(
        "button",
        "Open",
        [crate::actions::capability::RIGHT_CLICK]
    );
}

impl ActionOps for ProbeFailingAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Ok(ActionResult::delivered_unverified("right_click"))
    }
}

impl InputOps for ProbeFailingAdapter {}

impl SystemOps for ProbeFailingAdapter {
    crate::adapter::guarded_interaction_lease!();
}

fn save_refmap(source_app: Option<String>) -> String {
    let mut refmap = RefMap::new();
    let bounds = crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    refmap.allocate(RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(7),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some("Open".into()),
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
            available_actions: vec!["RightClick".into()],
        },
        source: crate::RefSource {
            source_app,
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
fn returns_action_success_without_a_synthetic_menu_probe() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_refmap(None);

    let value = execute(
        RefArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            timeout_ms: None,
        },
        &ProbeFailingAdapter { tree_error: None },
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["action"], "right_click");
    assert!(value.get("menu_probe").is_none());
}

#[test]
fn right_click_result_does_not_depend_on_a_followup_tree_probe() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_refmap(Some("TargetApp".into()));

    let value = execute(
        RefArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            timeout_ms: None,
        },
        &ProbeFailingAdapter {
            tree_error: Some(ErrorCode::ElementNotFound),
        },
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["action"], "right_click");
    assert!(value.get("menu_probe").is_none());
}
