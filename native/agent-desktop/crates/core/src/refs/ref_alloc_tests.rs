use super::*;
use crate::{AccessibilityNode, Rect};

fn node(role: &str, name: Option<&str>) -> AccessibilityNode {
    AccessibilityNode {
        ref_id: None,
        role: role.into(),
        identity: crate::NodeIdentity {
            retained_object: None,
            name: name.map(str::to_string),
            ..Default::default()
        },
        presentation: crate::NodePresentation {
            bounds: Some(Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            ..Default::default()
        },
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    }
}

fn source(pid: u32) -> crate::refs::ref_alloc_source::RefAllocSource<'static> {
    crate::refs::ref_alloc_source::RefAllocSource {
        pid: crate::ProcessId::new(pid),
        app: None,
        window_id: None,
        window_title: None,
        window_bounds_hash: None,
        process_instance: Some("test-instance"),
        surface: crate::adapter::SnapshotSurface::Window,
    }
}

#[test]
fn transform_tree_include_bounds_false_strips_bounds() {
    let n = node("group", None);
    let out = transform_tree(n, false, false, false);
    assert!(out.presentation.bounds.is_none());
}

#[test]
fn transform_tree_include_bounds_true_preserves_bounds() {
    let n = node("group", None);
    let out = transform_tree(n, true, false, false);
    assert!(out.presentation.bounds.is_some());
}

#[test]
fn transform_tree_interactive_only_prunes_noninteractive_leaves() {
    let mut root = node("window", Some("w"));
    root.children = vec![node("group", None), node("button", Some("OK"))];
    let out = transform_tree(root, true, true, false);
    assert_eq!(out.children.len(), 1);
    assert_eq!(out.children[0].role, "button");
}

#[test]
fn transform_tree_interactive_only_keeps_named_containers_with_children() {
    let mut labeled = node("group", Some("Toolbar"));
    labeled.children = vec![node("button", Some("Save"))];
    let mut root = node("window", Some("w"));
    root.children = vec![labeled];
    let out = transform_tree(root, true, true, false);
    assert_eq!(out.children.len(), 1);
    assert_eq!(out.children[0].children.len(), 1);
}

#[test]
fn transform_tree_compact_collapses_empty_single_child_chain() {
    let mut outer = node("group", None);
    let mut inner = node("group", None);
    outer.presentation.bounds = None;
    inner.presentation.bounds = None;
    inner.children = vec![node("button", Some("Go"))];
    outer.children = vec![inner];
    let mut root = node("window", Some("w"));
    root.children = vec![outer];
    let out = transform_tree(root, true, false, true);
    assert_eq!(out.children.len(), 1);
    assert_eq!(out.children[0].role, "button");
}

#[test]
fn compact_collapses_payload_free_chromium_group_wrapper() {
    let mut wrapper = node("group", None);
    wrapper.presentation.bounds = None;
    wrapper.children = vec![node("button", Some("Send"))];
    assert!(is_collapsible(&wrapper));
}

#[test]
fn compact_preserves_semantic_container_roles() {
    for role in [
        "webarea",
        "banner",
        "navigation",
        "main",
        "region",
        "table",
        "list",
    ] {
        let mut container = node(role, None);
        container.presentation.bounds = None;
        container.children = vec![node("button", Some("Child"))];
        assert!(!is_collapsible(&container), "{role} must retain its role");
    }
}

#[test]
fn compact_preserves_group_identity_truncation_and_capabilities() {
    let mut identified = transparent_group();
    identified.identity.native_id = Some(crate::ElementIdentifier {
        kind: crate::IdentifierKind::AxIdentifier,
        value: "renderer-node".into(),
    });
    assert!(!is_collapsible(&identified));

    let mut truncated = transparent_group();
    truncated.children_count = Some(17);
    assert!(!is_collapsible(&truncated));

    let mut actionable = transparent_group();
    actionable.presentation.available_actions = vec![crate::actions::capability::SET_FOCUS.into()];
    assert!(!is_collapsible(&actionable));

    let mut bounded = transparent_group();
    bounded.presentation.bounds = Some(Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    });
    assert!(!is_collapsible(&bounded));
}

fn transparent_group() -> AccessibilityNode {
    let mut group = node("group", None);
    group.presentation.bounds = None;
    group.children = vec![node("button", Some("Child"))];
    group
}

#[test]
fn transform_tree_compact_preserves_labeled_containers() {
    let mut named = node("group", Some("Toolbar"));
    named.children = vec![node("button", Some("Save"))];
    let mut root = node("window", Some("w"));
    root.children = vec![named];
    let out = transform_tree(root, true, false, true);
    assert_eq!(out.children.len(), 1);
    assert_eq!(out.children[0].role, "group");
    assert_eq!(out.children[0].identity.name.as_deref(), Some("Toolbar"));
}

#[test]
fn ref_entry_prefers_platform_actions() {
    let mut button = node("button", Some("Save"));
    button.presentation.available_actions = vec!["SetFocus".into()];

    let entry = ref_entry_from_node(&button, &source(7), None, &[0]);

    assert_eq!(entry.capabilities.available_actions, vec!["SetFocus"]);
}

#[test]
fn ref_entry_drops_empty_identity_text() {
    let mut button = node("button", Some(""));
    button.identity.value = Some(String::new());

    let entry = ref_entry_from_node(&button, &source(7), None, &[0]);

    assert!(entry.identity.name.is_none());
    assert!(entry.identity.value.is_none());
}

#[test]
fn ref_entry_preserves_meaningful_identity_text() {
    let mut button = node("button", Some("Save"));
    button.identity.value = Some("Primary".into());
    button.identity.description = Some("Commits changes".into());

    let entry = ref_entry_from_node(&button, &source(7), None, &[0]);

    assert_eq!(entry.identity.name.as_deref(), Some("Save"));
    assert_eq!(entry.identity.value.as_deref(), Some("Primary"));
    assert_eq!(
        entry.identity.description.as_deref(),
        Some("Commits changes")
    );
}

/// scrollarea/disclosure are not interactive roles, but they advertise real
/// actions and `scroll` / `expand` need a ref to target them.
#[test]
fn actionable_container_roles_receive_refs() {
    let mut scroll = node("scrollarea", Some("Log"));
    scroll.presentation.available_actions = vec!["Scroll".into()];
    assert!(is_ref_able(&scroll));

    let mut disclosure = node("disclosure", Some("Details"));
    disclosure.presentation.available_actions = vec!["Click".into()];
    assert!(is_ref_able(&disclosure));
}

/// Focus, context-menu, and scroll-into-view affordances are advertised on
/// nearly every node by web runtimes (Chromium/Electron), so on their own they
/// must not ref-allocate inert containers or text.
#[test]
fn ubiquitous_affordances_alone_do_not_confer_a_ref() {
    for actions in [
        vec!["SetFocus"],
        vec!["RightClick"],
        vec!["ScrollTo"],
        vec!["RightClick", "ScrollTo"],
        vec!["SetFocus", "RightClick", "ScrollTo"],
    ] {
        let mut group = node("group", Some("Panel"));
        group.presentation.available_actions = actions.iter().map(|a| a.to_string()).collect();
        assert!(
            !is_ref_able(&group),
            "group advertising only {actions:?} must not be ref-able"
        );
    }

    let mut paragraph = node("statictext", Some("Paragraph"));
    paragraph.presentation.available_actions = vec!["ScrollTo".into()];
    assert!(!is_ref_able(&paragraph));

    let inert = node("statictext", Some("Label"));
    assert!(!is_ref_able(&inert));
}

#[test]
fn primary_action_or_interactive_role_still_confers_a_ref_on_web_nodes() {
    let mut clickable = node("group", Some("Row"));
    clickable.presentation.available_actions =
        vec!["Click".into(), "RightClick".into(), "ScrollTo".into()];
    assert!(is_ref_able(&clickable));

    let mut button = node("button", Some("Menu"));
    button.presentation.available_actions = vec!["RightClick".into(), "ScrollTo".into()];
    assert!(is_ref_able(&button));
}

#[test]
fn allocate_refs_skips_web_container_noise() {
    let web_action = |role: &str, actions: &[&str]| {
        let mut n = node(role, Some(role));
        n.presentation.available_actions = actions.iter().map(|a| a.to_string()).collect();
        n
    };
    let mut wrapper = web_action("group", &["RightClick", "ScrollTo"]);
    wrapper.children = vec![web_action("statictext", &["ScrollTo"])];
    let mut root = node("window", Some("w"));
    root.children = vec![
        wrapper,
        web_action("group", &["Click", "RightClick", "ScrollTo"]),
        web_action("button", &["RightClick", "ScrollTo"]),
    ];

    let mut refmap = RefMap::new();
    let config = RefAllocConfig {
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds: true,
            interactive_only: true,
            compact: false,
        },
        source: source(7),
        scope: crate::refs::ref_alloc_scope::RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
    };
    let out = allocate_refs(root, &mut refmap, &config).unwrap();

    assert_eq!(refmap.len(), 2);
    let roles: Vec<_> = out
        .children
        .iter()
        .map(|child| child.role.as_str())
        .collect();
    assert_eq!(roles, ["group", "button"]);
    assert!(out.children.iter().all(|child| child.ref_id.is_some()));
}

#[test]
fn allocate_refs_records_structural_paths() {
    let mut root = node("window", Some("w"));
    let mut group = node("group", Some("List"));
    group.children = vec![node("button", Some("Open"))];
    root.children = vec![node("button", Some("Save")), group];

    let mut refmap = RefMap::new();
    let config = RefAllocConfig {
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds: true,
            interactive_only: false,
            compact: false,
        },
        source: crate::refs::ref_alloc_source::RefAllocSource {
            pid: crate::ProcessId::new(7),
            app: Some("Finder"),
            window_id: Some("w-42"),
            window_title: Some("Documents"),
            window_bounds_hash: None,
            process_instance: Some("test-instance"),
            surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::refs::ref_alloc_scope::RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
    };
    let out = allocate_refs(root, &mut refmap, &config).unwrap();

    let save_ref = out.children[0].ref_id.as_deref().unwrap();
    let open_ref = out.children[1].children[0].ref_id.as_deref().unwrap();
    assert_eq!(refmap.get(save_ref).unwrap().scope.path.as_slice(), [0]);
    assert_eq!(refmap.get(open_ref).unwrap().scope.path.as_slice(), [1, 0]);
    assert_eq!(
        refmap
            .get(open_ref)
            .unwrap()
            .source
            .source_window_id
            .as_deref(),
        Some("w-42")
    );
}

#[test]
fn allocate_refs_keeps_bounds_hash_when_snapshot_hides_bounds() {
    let mut root = node("window", Some("w"));
    root.children = vec![node("button", Some("Open"))];
    let mut refmap = RefMap::new();
    let config = RefAllocConfig {
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds: false,
            interactive_only: false,
            compact: false,
        },
        source: crate::refs::ref_alloc_source::RefAllocSource {
            pid: crate::ProcessId::new(7),
            app: Some("Finder"),
            window_id: Some("w-42"),
            window_title: Some("Documents"),
            window_bounds_hash: None,
            process_instance: Some("test-instance"),
            surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::refs::ref_alloc_scope::RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
    };

    let out = allocate_refs(root, &mut refmap, &config).unwrap();
    let open_ref = out.children[0].ref_id.as_deref().unwrap();
    let entry = refmap.get(open_ref).unwrap();

    assert!(out.children[0].presentation.bounds.is_none());
    assert!(entry.geometry.bounds.is_none());
    assert_eq!(entry.geometry.bounds_hash, Some(entry_hash()));
    assert_eq!(entry.scope.path.as_slice(), [0]);
    assert_eq!(entry.source.source_window_id.as_deref(), Some("w-42"));
    assert_eq!(
        entry.source.source_window_title.as_deref(),
        Some("Documents")
    );
}

fn entry_hash() -> u64 {
    Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    }
    .bounds_hash()
    .unwrap()
}

#[path = "ref_alloc_bounds_tests.rs"]
mod bounds_tests;
#[path = "ref_alloc_ordering_tests.rs"]
mod ordering_tests;
#[path = "ref_alloc_window_bounds_tests.rs"]
mod window_bounds_tests;
