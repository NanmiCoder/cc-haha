//! Fixes the cross-window `drag --wait-for` scoping defect: the post-action
//! wait must be able to observe the drop-target window, not only the pickup
//! window. See `crates/core/src/commands/drag.rs` (`WaitForScope`).
use super::*;
use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps, TreeOptions};
use crate::commands::wait_selector::{self, WaitSelectorInput};
use crate::context::WaitSelector;
use crate::refs::refs_test_support::HomeGuard;
use crate::{
    AccessibilityNode, AdapterError, CommandContext, DragParams, InteractionLease, ProcessId,
    WindowInfo, WindowState, system::window_filter::WindowFilter,
};
use serde_json::json;
use std::sync::Mutex;

/// Models a cross-window drag whose confirmation ("Dropped") surfaces only in
/// the destination window. Exposes two windows in distinct apps so
/// `resolve_window` pins `from` to `w-1` and `to` to `w-2`, and records every
/// window id the wait observes via `observe_tree` so a test can prove which
/// window was polled.
struct CrossAppWaitAdapter {
    captured: Mutex<Option<DragParams>>,
    observed: Mutex<Vec<String>>,
}

impl CrossAppWaitAdapter {
    fn new() -> Self {
        Self {
            captured: Mutex::new(None),
            observed: Mutex::new(Vec::new()),
        }
    }

    fn windows() -> Vec<WindowInfo> {
        vec![
            WindowInfo {
                id: "w-1".into(),
                title: "Source".into(),
                app: "App 1".into(),
                pid: ProcessId::new(1),
                process_instance: Some("test-instance".into()),
                bounds: None,
                state: WindowState {
                    is_focused: true,
                    ..Default::default()
                },
            },
            WindowInfo {
                id: "w-2".into(),
                title: "Destination".into(),
                app: "App 2".into(),
                pid: ProcessId::new(2),
                process_instance: Some("test-instance".into()),
                bounds: None,
                state: WindowState::default(),
            },
        ]
    }

    fn dropped_confirmation() -> AccessibilityNode {
        crate::adapter::minimal_accessibility_node("button", "Dropped")
    }

    fn window_node(window: &WindowInfo) -> AccessibilityNode {
        let children = (window.id == "w-2")
            .then(Self::dropped_confirmation)
            .into_iter()
            .collect();
        let mut node = crate::adapter::minimal_accessibility_node("window", &window.title);
        node.children = children;
        node
    }
}

impl ObservationOps for CrossAppWaitAdapter {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        let crate::locator::live_locator::ObservationRoot::Window(window) = root else {
            return Err(AdapterError::internal("expected window root"));
        };
        self.observed.lock().unwrap().push(window.id.clone());
        let node = Self::window_node(window);
        crate::adapter::observed_tree(
            &crate::locator::live_locator::ObservationRoot::Window(window),
            node,
        )
    }

    fn resolve_element_strict(
        &self,
        _entry: &crate::refs::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn list_windows(
        &self,
        filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(Self::windows()
            .into_iter()
            .filter(|window| {
                filter
                    .app
                    .as_deref()
                    .is_none_or(|app| window.app.as_str() == app)
            })
            .collect())
    }

    fn get_tree(
        &self,
        window: &WindowInfo,
        _opts: &TreeOptions,
        _deadline: crate::Deadline,
    ) -> Result<AccessibilityNode, AdapterError> {
        Ok(Self::window_node(window))
    }

    crate::adapter::complete_live_observation!(
        "button",
        "Item",
        [crate::actions::capability::CLICK]
    );
}

impl ActionOps for CrossAppWaitAdapter {}

impl InputOps for CrossAppWaitAdapter {
    fn drag(
        &self,
        params: DragParams,
        _lease: &InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        *self.captured.lock().unwrap() = Some(params);
        Ok(crate::adapter::test_report())
    }
}

impl SystemOps for CrossAppWaitAdapter {
    crate::adapter::guarded_interaction_lease!();
    crate::adapter::exact_window_focus!();
}

fn drag_args(snapshot_id: String, scope: WaitForScope) -> DragArgs {
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
        wait_for_scope: scope,
    }
}

fn wait_context(timeout_ms: u64) -> CommandContext {
    CommandContext::default()
        .with_headed(true)
        .with_wait_selector(Some(WaitSelector {
            query_raw: ":dropped".into(),
            gone: false,
            timeout_ms,
        }))
}

/// A same-window fixture: both endpoints resolve to `App 2` / `w-2`, so the
/// `from` and `to` `source_entry`s are identical and the scope choice is
/// invisible. The destination carries the "Dropped" confirmation.
fn same_window_snapshot() -> String {
    let store = crate::refs::refs_store::RefStore::new().unwrap();
    let mut refmap = crate::refs::RefMap::new();
    refmap.allocate(ref_entry(2));
    refmap.allocate(ref_entry(2));
    store.save_new_snapshot(&refmap).unwrap()
}

/// The default scope resolves a cross-window drag's `--wait-for` to the drop
/// target, so a destination-only confirmation is observed instead of timing
/// out against the source window.
#[test]
fn drag_wait_defaults_to_destination_window_and_finds_confirmation() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    let adapter = CrossAppWaitAdapter::new();

    let value = execute(
        drag_args(snapshot_id, WaitForScope::default()),
        &adapter,
        &wait_context(2_000),
    )
    .expect("destination carries the confirmation; default scope must poll it");

    assert_eq!(value["matched_selector"], ":dropped");
    assert_eq!(
        value["after_action"]["disposition"]["delivery"],
        "delivered_unverified"
    );
    assert!(value["after_action"].get("dragged").is_none());
    let observed = adapter.observed.lock().unwrap();
    assert!(
        observed.iter().any(|id| id == "w-2"),
        "the destination window must be polled: {observed:?}",
    );
    assert!(adapter.captured.lock().unwrap().is_some());
}

/// Escaping the default (destination) scope to the pickup window must still be
/// possible via `--wait-for-scope from`, and a destination-only confirmation
/// remains unreachable from the source window: the drag is delivered but the
/// wait times out polling only `w-1`.
#[test]
fn drag_wait_scoped_to_source_window_misses_destination_confirmation() {
    let _guard = HomeGuard::new();
    let snapshot_id = cross_app_snapshot();
    let adapter = CrossAppWaitAdapter::new();

    let error = execute(
        drag_args(snapshot_id, WaitForScope::From),
        &adapter,
        &wait_context(300),
    )
    .expect_err("source window cannot observe a destination-only confirmation");

    assert_eq!(error.code(), "TIMEOUT");
    let details = match &error {
        crate::AppError::Adapter(err) => {
            err.details.as_ref().expect("wait timeout carries details")
        }
        other => panic!("expected adapter TIMEOUT, got {other:?}"),
    };
    assert_eq!(details["kind"], json!("wait_timeout"));
    assert_eq!(
        details["after_action"]["disposition"]["delivery"],
        "delivered_unverified"
    );
    assert!(details["after_action"].get("dragged").is_none());
    let observed = adapter.observed.lock().unwrap();
    assert!(
        observed.iter().all(|id| id == "w-1"),
        "wait must only inspect the from window: {observed:?}",
    );
    assert!(
        !observed.iter().any(|id| id == "w-2"),
        "the drop-target window must never be inspected under from scope: {observed:?}",
    );
    assert!(adapter.captured.lock().unwrap().is_some());
}

/// The confirmation is observable in the destination window, proving the only
/// defect is the scoping choice: scoping `wait_selector` to `App 2` / `w-2`
/// matches immediately.
#[test]
fn wait_selector_scoped_to_destination_window_finds_the_confirmation() {
    let _guard = HomeGuard::new();
    let adapter = CrossAppWaitAdapter::new();

    let value = wait_selector::execute(
        WaitSelectorInput {
            query_raw: ":dropped".into(),
            gone: false,
            app: Some("App 2".into()),
            window_id: Some("w-2".into()),
            opts: TreeOptions::default(),
            timeout_ms: 1_000,
        },
        &adapter,
        &CommandContext::default(),
    )
    .expect("destination carries the confirmation");

    assert_eq!(value["matched_selector"], ":dropped");
}

/// A same-window drag has identical `from`/`to` endpoints, so the default
/// scope change is a no-op there: the shared window is polled and the
/// confirmation matches, guarding the previously-correct same-window path
/// against a regression from the destination default.
#[test]
fn drag_wait_same_window_drag_polls_the_shared_window_and_matches() {
    let _guard = HomeGuard::new();
    let snapshot_id = same_window_snapshot();
    let adapter = CrossAppWaitAdapter::new();

    let value = execute(
        drag_args(snapshot_id, WaitForScope::default()),
        &adapter,
        &wait_context(2_000),
    )
    .expect("the shared window carries the confirmation");

    assert_eq!(value["matched_selector"], ":dropped");
    assert_eq!(
        value["after_action"]["disposition"]["delivery"],
        "delivered_unverified"
    );
    assert!(value["after_action"].get("dragged").is_none());
    let observed = adapter.observed.lock().unwrap();
    assert!(
        observed.iter().any(|id| id == "w-2") && !observed.iter().any(|id| id == "w-1"),
        "same-window drag must poll the shared destination window: {observed:?}",
    );
    assert!(adapter.captured.lock().unwrap().is_some());
}
