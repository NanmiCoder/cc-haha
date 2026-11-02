use super::*;
use crate::AccessibilityNode;
use crate::AdapterError;
use crate::actions::action_request::ActionRequest;
use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::refs::ref_alloc::ref_entry_from_node;
use crate::refs::refs_test_support::HomeGuard;
use crate::{refs::RefMap, refs::refs_store::RefStore};
use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering},
};

struct DropProbe(Arc<AtomicU32>);

impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn node(role: &str) -> AccessibilityNode {
    AccessibilityNode {
        ref_id: None,
        role: role.into(),
        identity: Default::default(),
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    }
}

fn named(role: &str, name: &str) -> AccessibilityNode {
    let mut n = node(role);
    n.identity.name = Some(name.into());
    n
}

fn source(app: &'static str) -> crate::refs::ref_alloc_source::RefAllocSource<'static> {
    crate::refs::ref_alloc_source::RefAllocSource {
        pid: crate::ProcessId::new(42),
        app: Some(app),
        window_id: None,
        window_title: None,
        window_bounds_hash: None,
        process_instance: Some("test-instance"),
        surface: crate::adapter::SnapshotSurface::Window,
    }
}

struct StubAdapter {
    subtree: AccessibilityNode,
    subtree_error: Option<AdapterError>,
    resolve_calls: AtomicU32,
    drops: Arc<AtomicU32>,
    windows: Vec<crate::WindowInfo>,
    expected_app: Option<String>,
}

impl StubAdapter {
    fn new(subtree: AccessibilityNode) -> Self {
        Self {
            subtree,
            subtree_error: None,
            resolve_calls: AtomicU32::new(0),
            drops: Arc::new(AtomicU32::new(0)),
            windows: vec![window_info("w-42", true)],
            expected_app: None,
        }
    }

    fn with_windows(subtree: AccessibilityNode, windows: Vec<crate::WindowInfo>) -> Self {
        Self {
            subtree,
            subtree_error: None,
            resolve_calls: AtomicU32::new(0),
            drops: Arc::new(AtomicU32::new(0)),
            windows,
            expected_app: None,
        }
    }

    fn with_subtree_error(error: AdapterError) -> Self {
        Self {
            subtree: node("group"),
            subtree_error: Some(error),
            resolve_calls: AtomicU32::new(0),
            drops: Arc::new(AtomicU32::new(0)),
            windows: vec![window_info("w-42", true)],
            expected_app: None,
        }
    }
}

fn window_info(id: &str, focused: bool) -> crate::WindowInfo {
    crate::WindowInfo {
        id: id.into(),
        title: "Test".into(),
        app: "TestApp".into(),
        pid: crate::ProcessId::new(42),
        process_instance: Some("test-instance".into()),
        bounds: None,
        state: crate::WindowState {
            is_focused: focused,
            ..Default::default()
        },
    }
}

impl ObservationOps for StubAdapter {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        if let Some(error) = &self.subtree_error {
            return Err(error.clone());
        }
        crate::adapter::observed_tree(&root, self.subtree.clone())
    }

    fn list_windows(
        &self,
        filter: &crate::adapter::WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<crate::WindowInfo>, AdapterError> {
        if let Some(expected) = &self.expected_app {
            assert_eq!(filter.app.as_ref(), Some(expected));
        }
        Ok(self.windows.clone())
    }

    fn resolve_element_strict(
        &self,
        _entry: &crate::refs::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        Ok(NativeHandle::new(DropProbe(Arc::clone(&self.drops))))
    }
}

impl ActionOps for StubAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        Err(AdapterError::not_supported("execute_action"))
    }
}

impl InputOps for StubAdapter {}

impl SystemOps for StubAdapter {}

fn save_latest(refmap: RefMap) -> String {
    RefStore::new()
        .unwrap()
        .save_new_snapshot(&refmap)
        .expect("snapshot refmap should save")
}

fn save_session(session_id: &str, refmap: RefMap) -> String {
    RefStore::for_session(Some(session_id))
        .unwrap()
        .save_new_snapshot(&refmap)
        .expect("session snapshot refmap should save")
}

fn load_latest() -> RefMap {
    RefStore::new()
        .unwrap()
        .load_latest()
        .expect("latest snapshot should load")
}

fn load_session_snapshot(session_id: &str, snapshot_id: &str) -> RefMap {
    RefStore::for_session(Some(session_id))
        .unwrap()
        .load(Some(snapshot_id))
        .expect("session snapshot should load")
}

fn local_ref(ref_id: &str) -> String {
    crate::refs::ref_token::resolve_ref_target(ref_id)
        .expect("result refs must be snapshot-qualified")
        .1
}

fn seed_skeleton_refmap() -> RefMap {
    let mut map = RefMap::new();
    let anchor = ref_entry_from_node(&named("group", "Sidebar"), &source("TestApp"), None, &[0]);
    let _ = map.allocate(anchor);
    let other = ref_entry_from_node(&named("button", "Toolbar"), &source("TestApp"), None, &[1]);
    let _ = map.allocate(other);
    map
}

fn drill_opts() -> TreeOptions {
    TreeOptions {
        interactive_only: false,
        ..Default::default()
    }
}

#[test]
fn test_run_from_ref_returns_subtree_and_persists_refs() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_latest(seed_skeleton_refmap());

    let mut child_btn = named("button", "Save");
    child_btn.children = vec![];
    let mut subtree_root = named("group", "Sidebar");
    subtree_root.children = vec![child_btn];

    let adapter = StubAdapter::new(subtree_root);
    let result = run_from_ref(&adapter, &drill_opts(), "@e1", Some(&snapshot_id))
        .expect("drill should succeed");

    let on_disk = load_latest();
    assert_eq!(on_disk.len(), result.refmap.len());
    assert!(
        result.refmap.len() >= 3,
        "expected at least 2 skeleton + 1 drill ref, got {}",
        result.refmap.len()
    );

    let drill_ref = result
        .tree
        .children
        .iter()
        .find(|c| c.role == "button")
        .and_then(|c| c.ref_id.as_deref())
        .expect("button child should carry a ref");
    let drill_entry = on_disk.get(&local_ref(drill_ref)).expect("entry persisted");
    assert_eq!(drill_entry.scope.root_ref.as_deref(), Some("@e1"));
    assert!(
        drill_entry.scope.path_is_absolute,
        "drilled refs must retain an absolute path for fast, scoped resolution"
    );
    assert_eq!(drill_entry.scope.path.as_slice(), [0, 0]);
    assert_eq!(adapter.resolve_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.drops.load(Ordering::SeqCst), 1);
}

#[test]
fn test_run_from_ref_explicit_session_snapshot_with_matching_context() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_session("agent-a", seed_skeleton_refmap());

    let adapter = StubAdapter::new(named("button", "Save"));
    let context = crate::CommandContext::new(Some("agent-a".into()), None, false).unwrap();
    let result = run_from_ref_with_context(
        &adapter,
        &drill_opts(),
        &format!("@{snapshot_id}:e1"),
        &context,
        crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS,
    )
    .expect("session snapshot should drill within its namespace");

    assert_eq!(result.snapshot_id.as_deref(), Some(snapshot_id.as_str()));
    let on_disk = load_session_snapshot("agent-a", &snapshot_id);
    assert!(on_disk.get("@e1").is_some(), "skeleton anchor preserved");
    let drill_ref = result.tree.ref_id.as_deref().expect("drill ref");
    let drill_entry = on_disk
        .get(&local_ref(drill_ref))
        .expect("drill ref persisted");
    assert_eq!(drill_entry.identity.name.as_deref(), Some("Save"));
    assert!(
        RefStore::new()
            .unwrap()
            .latest_snapshot_id()
            .unwrap()
            .is_none()
    );
}

#[test]
fn test_run_from_ref_drops_handle_when_subtree_read_fails() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_latest(seed_skeleton_refmap());

    let adapter = StubAdapter::with_subtree_error(AdapterError::new(
        crate::ErrorCode::ActionFailed,
        "subtree failed",
    ));
    let result = run_from_ref(&adapter, &drill_opts(), "@e1", Some(&snapshot_id));

    assert!(result.is_err());
    assert_eq!(adapter.resolve_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.drops.load(Ordering::SeqCst), 1);
}

#[test]
fn test_run_from_ref_stale_root_returns_stale_ref() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_latest(RefMap::new());

    let adapter = StubAdapter::new(named("group", "Sidebar"));
    let result = run_from_ref(&adapter, &drill_opts(), "@e99", Some(&snapshot_id));
    let err = match result {
        Ok(_) => panic!("stale root must error"),
        Err(e) => e,
    };
    match err {
        AppError::Adapter(adapter_err) => {
            assert_eq!(adapter_err.code, crate::ErrorCode::StaleRef);
            let suggestion = adapter_err.suggestion.as_deref().unwrap_or("");
            assert!(
                suggestion.contains("snapshot"),
                "stale-ref suggestion should mention running a snapshot, got: {suggestion}"
            );
        }
        other => panic!("expected Adapter(StaleRef), got {other:?}"),
    }
}

#[test]
fn test_run_from_ref_re_drill_replaces_drill_refs_only() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_latest(seed_skeleton_refmap());

    let subtree = named("button", "Save");
    let adapter = StubAdapter::new(subtree);

    let first = run_from_ref(&adapter, &drill_opts(), "@e1", Some(&snapshot_id)).unwrap();
    let first_count = first.refmap.len();
    let first_button_ref = first.tree.ref_id.clone().expect("button should get a ref");

    let second = run_from_ref(&adapter, &drill_opts(), "@e1", Some(&snapshot_id)).unwrap();
    let second_count = second.refmap.len();
    let second_button_ref = second.tree.ref_id.clone().expect("button should get a ref");

    assert_eq!(
        first_count, second_count,
        "ref count stable across re-drill"
    );
    assert_ne!(
        first_button_ref, second_button_ref,
        "re-drill should issue a fresh ref id (counter continues)"
    );
    let on_disk = load_latest();
    assert!(on_disk.get("@e1").is_some(), "skeleton anchor preserved");
    assert!(on_disk.get(&local_ref(&second_button_ref)).is_some());
    assert!(
        on_disk.get(&local_ref(&first_button_ref)).is_none(),
        "first drill ref must be invalidated by remove_by_root_ref"
    );
}

#[path = "snapshot_ref_window_tests.rs"]
mod window_tests;

#[path = "snapshot_ref_merge_tests.rs"]
mod merge_tests;
