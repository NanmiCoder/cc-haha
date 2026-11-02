use crate::AccessibilityNode;
use crate::refs::RefMap;
use crate::refs::ref_alloc::{self, RefAllocConfig};

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

fn drill_config<'a>(
    source_app: Option<&'a str>,
    pid: u32,
    root_ref_id: &'a str,
    interactive_only: bool,
    compact: bool,
) -> RefAllocConfig<'a> {
    RefAllocConfig {
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds: false,
            interactive_only,
            compact,
        },
        source: crate::refs::ref_alloc_source::RefAllocSource {
            pid: crate::ProcessId::new(pid),
            app: source_app,
            window_id: None,
            window_title: Some("Drill Window"),
            window_bounds_hash: None,
            process_instance: Some("test-instance"),
            surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::refs::ref_alloc_scope::RefAllocScope {
            root_ref_id: Some(root_ref_id),
            path_prefix: &[],
        },
    }
}

#[test]
fn test_drill_alloc_tags_entries() {
    let mut btn = node("button");
    btn.identity.name = Some("Submit".into());
    let mut root = node("group");
    root.children = vec![btn];

    let mut refmap = RefMap::new();
    let config = drill_config(Some("TestApp"), 42, "@e5", false, false);
    let tree = ref_alloc::allocate_refs(root, &mut refmap, &config).unwrap();

    assert_eq!(refmap.len(), 1);
    let btn_ref = tree.children[0]
        .ref_id
        .as_deref()
        .expect("button should have ref");
    let entry = refmap.get(btn_ref).expect("entry should exist");
    assert_eq!(entry.scope.root_ref.as_deref(), Some("@e5"));
    assert_eq!(entry.process.pid, 42);
    assert_eq!(entry.source.source_app.as_deref(), Some("TestApp"));
}

#[test]
fn test_drill_alloc_respects_interactive_only() {
    let btn = node("button");
    let text = node("statictext");
    let mut root = node("group");
    root.children = vec![btn, text];

    let mut refmap = RefMap::new();
    let config = drill_config(None, 1, "@e1", true, false);
    let tree = ref_alloc::allocate_refs(root, &mut refmap, &config).unwrap();

    assert_eq!(tree.children.len(), 1);
    assert_eq!(tree.children[0].role, "button");
}

#[test]
fn test_drill_alloc_preserves_truncated_child() {
    let mut container = node("group");
    container.identity.name = Some("Sidebar".into());
    container.children_count = Some(4);
    let mut root = node("window");
    root.children = vec![container];

    let mut refmap = RefMap::new();
    let config = drill_config(None, 1, "@e1", true, false);
    let tree = ref_alloc::allocate_refs(root, &mut refmap, &config).unwrap();

    assert_eq!(tree.children.len(), 1);
    assert_eq!(tree.children[0].children_count, Some(4));
}

#[test]
fn test_drill_alloc_compact() {
    let mut btn = node("button");
    btn.identity.name = Some("OK".into());
    let mut wrapper = node("group");
    wrapper.children = vec![btn];
    let mut root = node("window");
    root.children = vec![wrapper];

    let mut refmap = RefMap::new();
    let config = drill_config(None, 1, "@e1", false, true);
    let tree = ref_alloc::allocate_refs(root, &mut refmap, &config).unwrap();

    assert_eq!(tree.children.len(), 1);
    assert_eq!(tree.children[0].role, "button");
}
