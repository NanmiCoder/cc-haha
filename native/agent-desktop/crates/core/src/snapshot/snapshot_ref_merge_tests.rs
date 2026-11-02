use super::*;

#[test]
fn test_run_from_ref_multiple_drill_downs_accumulate() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_latest(seed_skeleton_refmap());

    let adapter_one = StubAdapter::new(named("button", "FromE1"));
    let first = run_from_ref(&adapter_one, &drill_opts(), "@e1", Some(&snapshot_id)).unwrap();
    let from_e1_ref = first.tree.ref_id.clone().expect("first drill ref");

    let adapter_two = StubAdapter::new(named("button", "FromE2"));
    let second = run_from_ref(&adapter_two, &drill_opts(), "@e2", Some(&snapshot_id)).unwrap();
    let from_e2_ref = second.tree.ref_id.clone().expect("second drill ref");

    let on_disk = load_latest();
    assert!(on_disk.get("@e1").is_some(), "skeleton @e1 preserved");
    assert!(on_disk.get("@e2").is_some(), "skeleton @e2 preserved");
    let entry_one = on_disk
        .get(&local_ref(&from_e1_ref))
        .expect("@e1 drill survives");
    assert_eq!(entry_one.scope.root_ref.as_deref(), Some("@e1"));
    let entry_two = on_disk
        .get(&local_ref(&from_e2_ref))
        .expect("@e2 drill survives");
    assert_eq!(entry_two.scope.root_ref.as_deref(), Some("@e2"));
}

#[test]
fn test_drilldown_refmap_matches_golden_fixture() {
    let golden = include_str!("../../../../tests/fixtures/drilldown-refmap.json");
    let golden_value: serde_json::Value = serde_json::from_str(golden).unwrap();
    let expected_total = golden_value["expected_total"].as_u64().unwrap() as usize;

    let _guard = HomeGuard::new();
    let mut seed = RefMap::new();
    seed.allocate(ref_entry_from_node(
        &named("group", "Sidebar"),
        &source("Fixture"),
        None,
        &[0],
    ));
    seed.allocate(ref_entry_from_node(
        &named("group", "Toolbar"),
        &source("Fixture"),
        None,
        &[1],
    ));
    let snapshot_id = save_latest(seed);

    let mut sidebar_subtree = named("outline", "Sidebar");
    sidebar_subtree.children = vec![named("treeitem", "Recents"), named("treeitem", "Documents")];
    let adapter = StubAdapter::new(sidebar_subtree);
    let _ = run_from_ref(&adapter, &drill_opts(), "@e1", Some(&snapshot_id)).unwrap();

    let toolbar_subtree = named("button", "Back");
    let adapter = StubAdapter::new(toolbar_subtree);
    let _ = run_from_ref(&adapter, &drill_opts(), "@e2", Some(&snapshot_id)).unwrap();

    let on_disk = load_latest();
    assert_eq!(
        on_disk.len(),
        expected_total,
        "merged refmap should match golden fixture's expected_total"
    );

    let expected_pid = crate::ProcessId::new(42);
    for anchor in golden_value["skeleton_anchors"].as_array().unwrap() {
        let id = anchor["ref_id"].as_str().unwrap();
        let entry = on_disk.get(id).unwrap_or_else(|| panic!("missing {id}"));
        assert_eq!(entry.process.pid, expected_pid, "{id}");
        assert_eq!(entry.identity.role, anchor["role"].as_str().unwrap());
        assert_eq!(entry.identity.name.as_deref(), anchor["name"].as_str());
        assert!(
            entry.scope.root_ref.is_none(),
            "skeleton {id} must have null root_ref"
        );
    }

    for (key, root) in [("drilled_from_e1", "@e1"), ("drilled_from_e2", "@e2")] {
        for drill in golden_value[key].as_array().unwrap() {
            let id = drill["ref_id"].as_str().unwrap();
            let entry = on_disk.get(id).unwrap_or_else(|| panic!("missing {id}"));
            assert_eq!(entry.process.pid, expected_pid, "{id}");
            assert_eq!(entry.identity.role, drill["role"].as_str().unwrap(), "{id}");
            assert_eq!(
                entry.identity.name.as_deref(),
                drill["name"].as_str(),
                "{id}"
            );
            assert_eq!(entry.scope.root_ref.as_deref(), Some(root), "{id}");
            assert_eq!(drill["root_ref"].as_str(), Some(root), "{id}");
        }
    }
}

#[test]
fn test_run_from_ref_empty_subtree() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_latest(seed_skeleton_refmap());

    let adapter = StubAdapter::new(node("group"));
    let result = run_from_ref(&adapter, &drill_opts(), "@e1", Some(&snapshot_id)).unwrap();

    assert!(result.tree.children.is_empty());
    assert_eq!(
        result.refmap.len(),
        2,
        "no new refs added for empty subtree"
    );
}
