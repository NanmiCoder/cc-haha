use super::test_support::entry;
use super::*;
use crate::AdapterError;
use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps, WindowFilter};
use crate::context::WaitSelector;
use crate::refs::RefMap;
use crate::refs::refs_test_support::HomeGuard;
use crate::{AccessibilityNode, WindowInfo};
use crate::{actions::action::Action, actions::action_result::ActionResult};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU32, Ordering},
};

struct LeaseGuard(Arc<AtomicBool>);

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct ScopedWaitAdapter {
    request: Mutex<Option<ActionRequest>>,
    polled_app: Mutex<Option<String>>,
    lease_held: Arc<AtomicBool>,
    lease_free_polls: AtomicU32,
}

impl ScopedWaitAdapter {
    fn new() -> Self {
        Self {
            request: Mutex::new(None),
            polled_app: Mutex::new(None),
            lease_held: Arc::new(AtomicBool::new(false)),
            lease_free_polls: AtomicU32::new(0),
        }
    }
}

impl ObservationOps for ScopedWaitAdapter {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        if self.lease_held.load(Ordering::SeqCst) {
            return Err(AdapterError::internal(
                "post-action wait must poll with the interaction lease released",
            ));
        }
        self.lease_free_polls.fetch_add(1, Ordering::SeqCst);
        crate::adapter::observed_tree(
            &root,
            AccessibilityNode {
                ref_id: None,
                role: "window".into(),
                identity: crate::NodeIdentity {
                    retained_object: None,
                    name: Some("Saved!".into()),
                    ..Default::default()
                },
                presentation: Default::default(),
                children_count: None,
                subtree_truncated: false,
                children: vec![],
            },
        )
    }

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
        *self.polled_app.lock().unwrap() = filter.app.clone();
        Ok(vec![WindowInfo {
            id: "w-1".into(),
            title: "Doc".into(),
            app: filter.app.clone().unwrap_or_else(|| "TargetApp".into()),
            pid: crate::ProcessId::new(1),
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
        _opts: &crate::adapter::TreeOptions,
        _deadline: crate::Deadline,
    ) -> Result<AccessibilityNode, AdapterError> {
        Ok(AccessibilityNode {
            ref_id: None,
            role: "window".into(),
            identity: crate::NodeIdentity {
                retained_object: None,
                name: Some("Saved!".into()),
                ..Default::default()
            },
            presentation: Default::default(),
            children_count: None,
            subtree_truncated: false,
            children: vec![],
        })
    }

    crate::adapter::complete_live_observation!("button", "OK", [crate::actions::capability::CLICK]);
}

impl ActionOps for ScopedWaitAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        assert!(self.lease_held.load(Ordering::SeqCst));
        *self.request.lock().unwrap() = Some(request);
        Ok(ActionResult::delivered_unverified("ok"))
    }
}

impl InputOps for ScopedWaitAdapter {}

impl SystemOps for ScopedWaitAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        self.lease_held
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| AdapterError::internal("test lease already held"))?;
        crate::InteractionLease::guarded(deadline, LeaseGuard(Arc::clone(&self.lease_held)))
    }
}

#[test]
fn post_action_wait_scopes_to_source_app_and_merges_action_result() {
    let _guard = HomeGuard::new();
    let mut refmap = RefMap::new();
    let mut entry = entry();
    entry.source.source_app = Some("TargetApp".into());
    refmap.allocate(entry);
    let snapshot_id = RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap();
    let adapter = ScopedWaitAdapter::new();
    let context = CommandContext::default().with_wait_selector(Some(WaitSelector {
        query_raw: ":saved!".into(),
        gone: false,
        timeout_ms: 5_000,
    }));
    let args = RefArgs {
        ref_id: format!("@{}:e1", snapshot_id),
        timeout_ms: None,
    };

    let value = execute_ref_action_with_context(
        args,
        &adapter,
        ActionRequest::headless(Action::Click),
        &context,
    )
    .unwrap();

    assert_eq!(
        adapter.polled_app.lock().unwrap().as_deref(),
        Some("TargetApp")
    );
    assert!(!adapter.lease_held.load(Ordering::SeqCst));
    assert!(adapter.lease_free_polls.load(Ordering::SeqCst) >= 1);
    assert_eq!(value["after_action"]["action"], "ok");
    assert_eq!(value["matched_selector"], ":saved!");
}

struct MultiWindowAdapter;

impl ObservationOps for MultiWindowAdapter {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        let crate::locator::live_locator::ObservationRoot::Window(window) = root else {
            return Err(AdapterError::internal("expected window root"));
        };
        let children = (window.id == "w-target")
            .then(|| AccessibilityNode {
                ref_id: None,
                role: "button".into(),
                identity: crate::NodeIdentity {
                    retained_object: None,
                    name: Some("Saved!".into()),
                    ..Default::default()
                },
                presentation: Default::default(),
                children_count: None,
                subtree_truncated: false,
                children: vec![],
            })
            .into_iter()
            .collect();
        crate::adapter::observed_tree(
            &crate::locator::live_locator::ObservationRoot::Window(window),
            AccessibilityNode {
                ref_id: None,
                role: "window".into(),
                identity: crate::NodeIdentity {
                    retained_object: None,
                    name: Some(window.title.clone()),
                    ..Default::default()
                },
                presentation: Default::default(),
                children_count: None,
                subtree_truncated: false,
                children,
            },
        )
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![
            WindowInfo {
                id: "w-other".into(),
                title: "Other".into(),
                app: "App".into(),
                pid: crate::ProcessId::new(1),
                process_instance: Some("test-instance".into()),
                bounds: None,
                state: crate::WindowState {
                    is_focused: true,
                    ..Default::default()
                },
            },
            WindowInfo {
                id: "w-target".into(),
                title: "Target".into(),
                app: "App".into(),
                pid: crate::ProcessId::new(1),
                process_instance: Some("test-instance".into()),
                bounds: None,
                state: crate::WindowState {
                    is_focused: false,
                    ..Default::default()
                },
            },
        ])
    }

    fn get_tree(
        &self,
        win: &WindowInfo,
        _opts: &crate::adapter::TreeOptions,
        _deadline: crate::Deadline,
    ) -> Result<AccessibilityNode, AdapterError> {
        let children = if win.id == "w-target" {
            vec![AccessibilityNode {
                ref_id: None,
                role: "button".into(),
                identity: crate::NodeIdentity {
                    retained_object: None,
                    name: Some("Saved!".into()),
                    ..Default::default()
                },
                presentation: Default::default(),
                children_count: None,
                subtree_truncated: false,
                children: vec![],
            }]
        } else {
            vec![]
        };
        Ok(AccessibilityNode {
            ref_id: None,
            role: "window".into(),
            identity: crate::NodeIdentity {
                retained_object: None,
                name: Some(win.title.clone()),
                ..Default::default()
            },
            presentation: Default::default(),
            children_count: None,
            subtree_truncated: false,
            children,
        })
    }

    crate::adapter::complete_live_observation!("button", "OK", [crate::actions::capability::CLICK]);
}

impl ActionOps for MultiWindowAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Ok(ActionResult::delivered_unverified("ok"))
    }
}

impl InputOps for MultiWindowAdapter {}

impl SystemOps for MultiWindowAdapter {
    crate::adapter::guarded_interaction_lease!();
}

#[test]
fn post_action_wait_polls_acted_on_window_not_focused_window() {
    let _guard = HomeGuard::new();
    let mut refmap = RefMap::new();
    let mut entry = entry();
    entry.source.source_app = Some("App".into());
    entry.source.source_window_id = Some("w-target".into());
    refmap.allocate(entry);
    let snapshot_id = RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap();
    let context = CommandContext::default().with_wait_selector(Some(WaitSelector {
        query_raw: ":saved!".into(),
        gone: false,
        timeout_ms: 500,
    }));
    let args = RefArgs {
        ref_id: format!("@{}:e1", snapshot_id),
        timeout_ms: None,
    };

    let value = execute_ref_action_with_context(
        args,
        &MultiWindowAdapter,
        ActionRequest::headless(Action::Click),
        &context,
    )
    .expect("wait must match in the acted-on window, not the focused empty window");
    assert_eq!(value["matched_selector"], ":saved!");
    assert_eq!(value["window"]["id"], "w-target");
}

#[path = "helpers_ref_action_wait_result_tests.rs"]
mod result_tests;
