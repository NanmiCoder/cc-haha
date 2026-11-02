use super::*;

#[test]
fn native_id_ancestor_covers_unnamed_boundaries() {
    let mut split_view = node("group");
    split_view.identity.native_id = Some(crate::ElementIdentifier {
        kind: crate::IdentifierKind::AxIdentifier,
        value: "main, SidebarNavigationSplitView".into(),
    });
    split_view.children = (0..3)
        .map(|_| {
            let mut boundary = node("group");
            boundary.children_count = Some(1);
            boundary
        })
        .collect();
    let mut root = node("window");
    root.children = vec![split_view];

    let mut refmap = RefMap::new();
    let result = ref_alloc::allocate_refs(root, &mut refmap, &run_config(false, false)).unwrap();

    let split_view = &result.children[0];
    assert!(split_view.ref_id.is_some());
    assert!(
        split_view
            .children
            .iter()
            .all(|boundary| boundary.ref_id.is_none())
    );
    let entry = refmap.get(split_view.ref_id.as_deref().unwrap()).unwrap();
    assert_eq!(
        entry
            .identity
            .native_id
            .as_ref()
            .map(|identifier| identifier.value.as_str()),
        Some("main, SidebarNavigationSplitView")
    );
}

#[test]
fn web_boundary_with_only_ubiquitous_affordances_gets_anchor_ref() {
    let mut boundary = node("group");
    boundary.identity.name = Some("Task list".into());
    boundary.presentation.available_actions = vec!["RightClick".into(), "ScrollTo".into()];
    boundary.children_count = Some(40);
    let mut root = node("window");
    root.children = vec![boundary];

    let mut refmap = RefMap::new();
    let result = ref_alloc::allocate_refs(root, &mut refmap, &run_config(false, false)).unwrap();

    let boundary = &result.children[0];
    let entry = refmap.get(boundary.ref_id.as_deref().unwrap()).unwrap();
    assert!(entry.capabilities.available_actions.is_empty());
    assert_eq!(refmap.len(), 1);
}

#[test]
fn unlabeled_bounded_boundary_gets_drill_ref() {
    let mut boundary = node("group");
    boundary.children_count = Some(5);
    boundary.presentation.bounds = Some(crate::Rect {
        x: 10.0,
        y: 20.0,
        width: 300.0,
        height: 400.0,
    });
    let mut root = node("window");
    root.children = vec![boundary];

    let mut refmap = RefMap::new();
    let result = ref_alloc::allocate_refs(root, &mut refmap, &run_config(false, false)).unwrap();

    let boundary = &result.children[0];
    assert!(boundary.ref_id.is_some());
    assert!(boundary.presentation.bounds.is_none());
    let entry = refmap.get(boundary.ref_id.as_deref().unwrap()).unwrap();
    assert!(
        entry.geometry.bounds.is_some(),
        "geometry is this anchor's only evidence, and the promotion that resolves it needs the rect, not just the hash"
    );
    assert!(entry.geometry.bounds_hash.is_some());
}

/// The narrowing holds: an anchor carrying a name of its own is resolved by
/// that name, so hiding bounds still strips its rect. Without this the
/// assertion above would read as "always keep bounds" and would re-open the
/// size decision the ref-able allocation path already settled.
#[test]
fn a_named_bounded_boundary_still_has_its_rect_stripped() {
    let mut boundary = node("group");
    boundary.identity.name = Some("Sidebar".into());
    boundary.children_count = Some(5);
    boundary.presentation.bounds = Some(crate::Rect {
        x: 10.0,
        y: 20.0,
        width: 300.0,
        height: 400.0,
    });
    let mut root = node("window");
    root.children = vec![boundary];

    let mut refmap = RefMap::new();
    let result = ref_alloc::allocate_refs(root, &mut refmap, &run_config(false, false)).unwrap();

    let boundary = &result.children[0];
    let entry = refmap.get(boundary.ref_id.as_deref().unwrap()).unwrap();
    assert!(crate::refs::ref_identity::has_meaningful_identity(entry));
    assert!(entry.geometry.bounds.is_none());
}

#[test]
fn deepest_resolvable_anchor_wins() {
    let mut boundary = node("group");
    boundary.children_count = Some(5);
    boundary.presentation.bounds = Some(crate::Rect {
        x: 10.0,
        y: 20.0,
        width: 300.0,
        height: 400.0,
    });
    let mut split_view = node("group");
    split_view.identity.native_id = Some(crate::ElementIdentifier {
        kind: crate::IdentifierKind::AxIdentifier,
        value: "split-view".into(),
    });
    split_view.children = vec![boundary];
    let mut root = node("window");
    root.children = vec![split_view];

    let mut refmap = RefMap::new();
    let result = ref_alloc::allocate_refs(root, &mut refmap, &run_config(false, false)).unwrap();

    assert!(result.children[0].ref_id.is_none());
    assert!(result.children[0].children[0].ref_id.is_some());
    assert_eq!(refmap.len(), 1);
}
