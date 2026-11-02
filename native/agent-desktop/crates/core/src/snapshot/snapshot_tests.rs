use super::*;
use crate::AccessibilityNode;

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

fn run_config(compact: bool, interactive_only: bool) -> RefAllocConfig<'static> {
    RefAllocConfig {
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds: false,
            interactive_only,
            compact,
        },
        source: crate::refs::ref_alloc_source::RefAllocSource {
            pid: crate::ProcessId::new(1),
            app: Some("Test"),
            window_id: None,
            window_title: Some("Test Window"),
            window_bounds_hash: None,
            process_instance: Some("test-instance"),
            surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::refs::ref_alloc_scope::RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
    }
}

fn run_compact(tree: AccessibilityNode) -> AccessibilityNode {
    let mut refmap = RefMap::new();
    ref_alloc::allocate_refs(tree, &mut refmap, &run_config(true, false)).unwrap()
}

fn run_compact_interactive(tree: AccessibilityNode) -> AccessibilityNode {
    let mut refmap = RefMap::new();
    ref_alloc::allocate_refs(tree, &mut refmap, &run_config(true, true)).unwrap()
}

#[test]
fn test_compact_collapses_single_child_chain() {
    let mut btn = node("button");
    btn.identity.name = Some("Send".into());
    let mut g1 = node("group");
    g1.children = vec![btn];
    let mut g2 = node("group");
    g2.children = vec![g1];
    let mut root = node("window");
    root.children = vec![g2];

    let result = run_compact(root);
    assert_eq!(result.role, "window");
    assert_eq!(result.children.len(), 1);
    assert_eq!(result.children[0].role, "button");
    assert_eq!(result.children[0].identity.name.as_deref(), Some("Send"));
}

#[test]
fn test_compact_preserves_named_containers() {
    let btn = node("button");
    let mut named = node("group");
    named.identity.name = Some("Sidebar".into());
    named.children = vec![btn];
    let mut root = node("window");
    root.children = vec![named];

    let result = run_compact(root);
    assert_eq!(result.children.len(), 1);
    assert_eq!(result.children[0].role, "group");
    assert_eq!(result.children[0].identity.name.as_deref(), Some("Sidebar"));
}

#[test]
fn test_compact_preserves_description() {
    let btn = node("button");
    let mut desc_node = node("group");
    desc_node.identity.description = Some("toolbar".into());
    desc_node.children = vec![btn];
    let mut root = node("window");
    root.children = vec![desc_node];

    let result = run_compact(root);
    assert_eq!(result.children.len(), 1);
    assert_eq!(result.children[0].role, "group");
    assert_eq!(
        result.children[0].identity.description.as_deref(),
        Some("toolbar")
    );
}

#[test]
fn test_compact_preserves_states() {
    let btn = node("button");
    let mut disabled = node("group");
    disabled.presentation.states = vec!["disabled".into()];
    disabled.children = vec![btn];
    let mut root = node("window");
    root.children = vec![disabled];

    let result = run_compact(root);
    assert_eq!(result.children.len(), 1);
    assert_eq!(result.children[0].role, "group");
    assert_eq!(result.children[0].presentation.states, vec!["disabled"]);
}

#[test]
fn test_compact_preserves_multi_child() {
    let btn = node("button");
    let tf = node("textfield");
    let mut group = node("group");
    group.children = vec![btn, tf];
    let mut root = node("window");
    root.children = vec![group];

    let result = run_compact(root);
    assert_eq!(result.children.len(), 1);
    assert_eq!(result.children[0].role, "group");
    assert_eq!(result.children[0].children.len(), 2);
}

#[test]
fn test_compact_with_interactive_only() {
    let mut btn = node("button");
    btn.identity.name = Some("OK".into());
    let text = node("statictext");
    let mut g1 = node("group");
    g1.children = vec![btn];
    let mut g2 = node("group");
    g2.children = vec![text];
    let mut root = node("window");
    root.children = vec![g1, g2];

    let result = run_compact_interactive(root);
    assert_eq!(result.children.len(), 1);
    assert_eq!(result.children[0].role, "button");
    assert!(result.children[0].ref_id.is_some());
}

#[test]
fn zero_sized_actionable_node_remains_addressable() {
    let mut button = node("button");
    button.identity.name = Some("zero-bounds-button".into());
    button.presentation.bounds = Some(crate::Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    });
    let mut root = node("window");
    root.children = vec![button];
    let mut refmap = RefMap::new();

    let result = ref_alloc::allocate_refs(root, &mut refmap, &run_config(false, false)).unwrap();

    assert_eq!(
        result.children[0].identity.name.as_deref(),
        Some("zero-bounds-button")
    );
    assert!(result.children[0].ref_id.is_some());
    assert_eq!(refmap.len(), 1);
}

#[test]
fn test_skeleton_named_container_gets_ref() {
    let mut container = node("group");
    container.identity.name = Some("Sidebar".into());
    container.children_count = Some(5);
    let mut root = node("window");
    root.children = vec![container];

    let mut refmap = RefMap::new();
    let result = ref_alloc::allocate_refs(root, &mut refmap, &run_config(false, false)).unwrap();

    assert!(result.children[0].ref_id.is_some());
    assert_eq!(refmap.len(), 1);
    let entry = refmap
        .get(result.children[0].ref_id.as_deref().unwrap())
        .unwrap();
    assert!(entry.capabilities.available_actions.is_empty());
}

#[test]
fn test_skeleton_unnamed_container_no_ref() {
    let mut container = node("group");
    container.children_count = Some(5);
    let mut root = node("window");
    root.children = vec![container];

    let mut refmap = RefMap::new();
    let result = ref_alloc::allocate_refs(root, &mut refmap, &run_config(false, false)).unwrap();

    assert!(result.children[0].ref_id.is_none());
    assert_eq!(refmap.len(), 0);
}

#[test]
fn test_skeleton_anchor_suppressed_in_drilldown() {
    let mut anchor = node("group");
    anchor.identity.name = Some("Channels".into());
    anchor.children_count = Some(8);
    let mut root = node("group");
    root.children = vec![anchor];

    let mut refmap = RefMap::new();
    let config = RefAllocConfig {
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds: false,
            interactive_only: false,
            compact: false,
        },
        source: crate::refs::ref_alloc_source::RefAllocSource {
            pid: crate::ProcessId::new(1),
            app: Some("Test"),
            window_id: None,
            window_title: Some("Test Window"),
            window_bounds_hash: None,
            process_instance: Some("test-instance"),
            surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::refs::ref_alloc_scope::RefAllocScope {
            root_ref_id: Some("@e3"),
            path_prefix: &[],
        },
    };
    let result = ref_alloc::allocate_refs(root, &mut refmap, &config).unwrap();

    assert!(
        result.children[0].ref_id.is_none(),
        "skeleton anchors must not be created during drill-down to prevent orphaned ref accumulation"
    );
    assert_eq!(refmap.len(), 0);
}

#[test]
fn test_skeleton_described_container_gets_ref() {
    let mut container = node("group");
    container.identity.description = Some("Channels and direct messages".into());
    container.children_count = Some(12);
    let mut root = node("window");
    root.children = vec![container];

    let mut refmap = RefMap::new();
    let result = ref_alloc::allocate_refs(root, &mut refmap, &run_config(false, false)).unwrap();

    assert!(result.children[0].ref_id.is_some());
    assert_eq!(refmap.len(), 1);
}

#[test]
fn test_skeleton_truncated_node_survives_interactive_only() {
    let mut container = node("group");
    container.identity.name = Some("Content".into());
    container.children_count = Some(10);
    let mut root = node("window");
    root.children = vec![container];

    let mut refmap = RefMap::new();
    let result = ref_alloc::allocate_refs(root, &mut refmap, &run_config(false, true)).unwrap();

    assert_eq!(result.children.len(), 1);
    assert_eq!(result.children[0].children_count, Some(10));
}

#[test]
fn test_skeleton_fixture_matches_golden() {
    let golden = include_str!("../../../../tests/fixtures/skeleton-tree.json");
    let golden_value: serde_json::Value = serde_json::from_str(golden).unwrap();

    let mut sidebar = node("group");
    sidebar.identity.name = Some("Sidebar".into());
    sidebar.children_count = Some(26);

    let mut described = node("group");
    described.identity.description = Some("Channels and direct messages".into());
    described.children_count = Some(12);

    let mut send = node("button");
    send.identity.name = Some("Send".into());
    let mut msg = node("textfield");
    msg.identity.name = Some("Message".into());
    let mut content = node("group");
    content.identity.name = Some("Content".into());
    content.children = vec![send, msg];

    let mut root = node("window");
    root.identity.name = Some("Test Window".into());
    root.children = vec![sidebar, described, content];

    let mut refmap = RefMap::new();
    let config = RefAllocConfig {
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds: false,
            interactive_only: false,
            compact: false,
        },
        source: crate::refs::ref_alloc_source::RefAllocSource {
            pid: crate::ProcessId::new(42),
            app: Some("Fixture"),
            window_id: None,
            window_title: Some("Fixture Window"),
            window_bounds_hash: None,
            process_instance: Some("test-instance"),
            surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::refs::ref_alloc_scope::RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
    };
    let result = ref_alloc::allocate_refs(root, &mut refmap, &config).unwrap();

    assert_eq!(refmap.len(), 4, "should allocate 4 refs total");
    let result_value = serde_json::to_value(&result).unwrap();

    assert_eq!(result_value, golden_value);
}

#[path = "skeleton_anchor_tests.rs"]
mod skeleton_anchor_tests;
