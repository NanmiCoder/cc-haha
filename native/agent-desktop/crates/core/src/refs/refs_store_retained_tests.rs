use super::*;
use crate::refs::refs_test_support::HomeGuard;
use std::collections::HashSet;

fn map(token: &str) -> RefMap {
    let node = serde_json::from_str(r#"{"role":"button","name":"Target"}"#).unwrap();
    let source = crate::refs::ref_alloc_source::RefAllocSource {
        pid: crate::ProcessId::new(42),
        app: Some("App"),
        window_id: Some("w-42"),
        window_title: None,
        window_bounds_hash: None,
        process_instance: Some("instance"),
        surface: crate::SnapshotSurface::Window,
    };
    let mut entry = crate::refs::ref_alloc::ref_entry_from_node(&node, &source, None, &[0]);
    entry.identity.retained_object = Some(token.into());
    let mut map = RefMap::new();
    map.allocate(entry);
    map
}

#[test]
fn retained_tokens_follow_all_saved_snapshots_and_the_selected_namespace() {
    let _home = HomeGuard::new();
    let store = RefStore::for_session(Some("owner")).unwrap();
    assert!(store.retained_object_tokens().unwrap().is_empty());
    let first = store.save_new_snapshot(&map("host:1")).unwrap();
    store.save_new_snapshot(&map("host:2")).unwrap();
    RefStore::for_session(Some("other"))
        .unwrap()
        .save_new_snapshot(&map("other:1"))
        .unwrap();
    assert_eq!(
        store.retained_object_tokens().unwrap(),
        HashSet::from(["host:1".into(), "host:2".into(),])
    );
    store.save_snapshot(&first, &RefMap::new()).unwrap();
    assert_eq!(
        store.retained_object_tokens().unwrap(),
        HashSet::from(["host:2".into()])
    );
}

#[test]
fn stray_directory_entries_do_not_count_toward_the_inventory_limit() {
    let _home = HomeGuard::new();
    let store = RefStore::new().unwrap();
    store.save_new_snapshot(&map("host:1")).unwrap();
    let snapshots = store.base_dir().join("snapshots");
    for index in 0..MAX_SAVED_SNAPSHOTS {
        std::fs::create_dir_all(snapshots.join(format!("stray file {index}.json"))).unwrap();
    }
    assert_eq!(
        store.retained_object_tokens().unwrap(),
        HashSet::from(["host:1".into()])
    );
}

#[test]
fn an_unreadable_snapshot_prevents_a_partial_prune() {
    let _home = HomeGuard::new();
    let store = RefStore::new().unwrap();
    let id = store.save_new_snapshot(&map("host:1")).unwrap();
    write_private_file(&store.snapshot_path(&id), b"invalid json").unwrap();
    assert!(store.retained_object_tokens().is_err());
}
