use super::*;

/// Refs must be assigned in depth-first document order.
/// Given: window → [button("A"), group → [button("B"), button("C")]],
/// DFS visits A then B then C, so @e1=A, @e2=B, @e3=C.
/// A regression that allocates in BFS order (A, then skipping group to find B
/// last) would violate the contract the CLI documents and agents depend on.
#[test]
fn allocate_refs_assigns_refs_in_depth_first_order() {
    let btn_a = node("button", Some("A"));
    let btn_b = node("button", Some("B"));
    let btn_c = node("button", Some("C"));
    let mut group = node("group", None);
    group.children = vec![btn_b, btn_c];
    let mut root = node("window", Some("w"));
    root.children = vec![btn_a, group];

    let mut refmap = RefMap::new();
    let config = RefAllocConfig {
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds: false,
            interactive_only: false,
            compact: false,
        },
        source: crate::refs::ref_alloc_source::RefAllocSource {
            pid: crate::ProcessId::new(1),
            app: None,
            window_id: None,
            window_title: None,
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

    let a_ref = out.children[0].ref_id.as_deref().unwrap();
    let b_ref = out.children[1].children[0].ref_id.as_deref().unwrap();
    let c_ref = out.children[1].children[1].ref_id.as_deref().unwrap();

    assert_eq!(a_ref, "@e1", "first DFS interactive node must be @e1");
    assert_eq!(b_ref, "@e2", "second DFS interactive node must be @e2");
    assert_eq!(c_ref, "@e3", "third DFS interactive node must be @e3");
}

/// A node whose available_actions list contains SetFocus alongside a real
/// primary action must be ref-able, because advertises_primary_action
/// filters to actions that are not SetFocus.
#[test]
fn node_with_primary_action_alongside_set_focus_is_ref_able() {
    let mut panel = node("group", Some("Panel"));
    panel.presentation.available_actions = vec!["SetFocus".into(), "Scroll".into()];
    assert!(
        is_ref_able(&panel),
        "group with SetFocus+Scroll must be ref-able via the primary action path"
    );
}

/// Each role in the hardcoded list must be ref-able by role alone (no actions
/// needed). Using a literal list rather than iterating INTERACTIVE_ROLES means
/// removing any of these from the constant will actually fail this test.
#[test]
fn representative_interactive_roles_are_ref_able_by_role_alone() {
    for role in [
        "button",
        "textfield",
        "checkbox",
        "link",
        "slider",
        "combobox",
        "treeitem",
        "cell",
        "radiobutton",
        "tab",
        "menuitem",
        "switch",
        "colorwell",
        "menubutton",
        "incrementor",
        "dockitem",
    ] {
        let n = node(role, None);
        assert!(
            is_ref_able(&n),
            "'{role}' must be ref-able by role alone with no available_actions"
        );
    }
}

#[test]
fn allocate_refs_keeps_bounds_in_refmap_when_snapshot_includes_bounds() {
    let mut root = node("window", Some("w"));
    root.children = vec![node("button", Some("Open"))];
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
    let open_ref = out.children[0].ref_id.as_deref().unwrap();
    let entry = refmap.get(open_ref).unwrap();

    assert!(out.children[0].presentation.bounds.is_some());
    assert!(entry.geometry.bounds.is_some());
    assert!(entry.geometry.bounds_hash.is_some());
}

#[test]
fn actionable_unknown_role_keeps_node_without_consuming_ref_id() {
    let first = node("button", Some("First"));
    let mut unknown = node("unknown", Some("Custom control"));
    unknown.presentation.available_actions = vec!["Click".into()];
    let last = node("button", Some("Last"));
    let mut root = node("window", Some("w"));
    root.children = vec![first, unknown, last];
    let mut refmap = RefMap::new();
    let mut config = allocation_config(true);
    config.options.interactive_only = true;

    let out = allocate_refs(root, &mut refmap, &config).unwrap();

    assert_eq!(out.children.len(), 3);
    assert_eq!(out.children[0].ref_id.as_deref(), Some("@e1"));
    assert!(out.children[1].ref_id.is_none());
    assert_eq!(out.children[1].role, "unknown");
    assert_eq!(out.children[2].ref_id.as_deref(), Some("@e2"));
    assert_eq!(refmap.len(), 2);
}

#[test]
fn out_of_range_bounds_stay_in_tree_but_not_ref_geometry() {
    let mut bounded = node("button", Some("Far away"));
    bounded.presentation.bounds = Some(Rect {
        x: 10_000_001.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    });
    let mut root = node("window", Some("w"));
    root.children = vec![bounded];
    let mut refmap = RefMap::new();

    let out = allocate_refs(root, &mut refmap, &allocation_config(true)).unwrap();

    let child = &out.children[0];
    assert_eq!(
        child.presentation.bounds.map(|bounds| bounds.x),
        Some(10_000_001.0)
    );
    let entry = refmap.get(child.ref_id.as_deref().unwrap()).unwrap();
    assert!(entry.geometry.bounds.is_none());
    assert!(entry.geometry.bounds_hash.is_none());
}

#[test]
fn structural_allocation_failure_still_aborts_snapshot() {
    let mut refmap: RefMap = serde_json::from_value(serde_json::json!({
        "inner": {},
        "counter": u32::MAX
    }))
    .unwrap();
    let mut root = node("window", Some("w"));
    root.children = vec![node("button", Some("First"))];

    let result = allocate_refs(root, &mut refmap, &allocation_config(true));

    let Err(error) = result else {
        panic!("identifier exhaustion must remain terminal");
    };
    assert!(error.to_string().contains("identifier space"));
}

fn allocation_config(include_bounds: bool) -> RefAllocConfig<'static> {
    RefAllocConfig {
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds,
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
    }
}

#[test]
fn allocate_refs_keeps_a_runtime_id_identifier_with_its_kind() {
    let value = r#"tray:{"owner":":1.7","object_path":"/org/ayatana/NotificationItem/x","menu_path":null,"entry_id":null,"label_path":[]}"#;
    let mut item = node("menubutton", Some("Dropbox"));
    item.identity.native_id = Some(crate::ElementIdentifier {
        kind: crate::IdentifierKind::RuntimeId,
        value: value.into(),
    });
    let mut root = node("window", Some("Tray"));
    root.children = vec![item];
    let mut refmap = RefMap::new();

    let out = allocate_refs(root, &mut refmap, &allocation_config(true)).unwrap();

    let ref_id = out.children[0]
        .ref_id
        .as_deref()
        .expect("a tray item with a RuntimeId identifier still receives a ref");
    let stored = refmap
        .get(ref_id)
        .unwrap()
        .identity
        .native_id
        .as_ref()
        .expect("the identifier is recorded");
    assert_eq!(stored.kind, crate::IdentifierKind::RuntimeId);
    assert_eq!(stored.value, value);
}

#[test]
fn transform_tree_interactive_only_prunes_leaves_with_only_ubiquitous_affordances() {
    let mut noise = node("statictext", Some("row"));
    noise.presentation.available_actions = vec!["RightClick".into(), "ScrollTo".into()];
    let mut clickable = node("statictext", Some("link-like"));
    clickable.presentation.available_actions =
        vec!["Click".into(), "RightClick".into(), "ScrollTo".into()];
    let mut root = node("window", Some("w"));
    root.children = vec![noise, clickable];

    let out = transform_tree(root, true, true, false);

    assert_eq!(out.children.len(), 1);
    assert_eq!(out.children[0].identity.name.as_deref(), Some("link-like"));
}
