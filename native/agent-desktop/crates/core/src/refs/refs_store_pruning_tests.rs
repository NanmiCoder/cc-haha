use super::*;

#[test]
fn save_new_snapshot_prunes_old_snapshots_without_removing_latest() {
    let _guard = HomeGuard::new();
    let store = RefStore::new().unwrap();
    let first_id = store.save_new_snapshot(&map_with("First")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let mut latest_id = first_id.clone();

    for i in 0..=MAX_SAVED_SNAPSHOTS {
        latest_id = store
            .save_new_snapshot(&map_with(&format!("Snapshot {i}")))
            .unwrap();
    }

    let count = std::fs::read_dir(store.snapshots_dir())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .count();

    assert!(count <= MAX_SAVED_SNAPSHOTS);
    assert!(store.snapshot_path(&latest_id).is_file());
    assert!(!store.snapshot_path(&first_id).exists());
    assert_eq!(
        store.latest_snapshot_id().unwrap().as_deref(),
        Some(latest_id.as_str())
    );
}

#[test]
fn update_existing_refuses_to_recreate_a_missing_snapshot() {
    let _guard = HomeGuard::new();
    let store = RefStore::new().unwrap();
    let snapshot_id = store.save_new_snapshot(&map_with("Original")).unwrap();
    std::fs::remove_dir_all(store.snapshots_dir().join(&snapshot_id)).unwrap();

    let err = store
        .update_existing_snapshot(&snapshot_id, "@e1", &entry("Original"), |_| Ok(()))
        .unwrap_err();

    assert_eq!(err.code(), "SNAPSHOT_NOT_FOUND");
    assert!(!store.snapshot_path(&snapshot_id).exists());
}

#[test]
fn duplicate_snapshot_id_across_sessions_remains_isolated() {
    let _guard = HomeGuard::new();
    let store_a = RefStore::for_session(Some("agent-a")).unwrap();
    let store_b = RefStore::for_session(Some("agent-b")).unwrap();
    let snapshot_id = store_a.save_new_snapshot(&map_with("A")).unwrap();
    store_b.save_snapshot(&snapshot_id, &map_with("B")).unwrap();

    let err = RefStore::new()
        .unwrap()
        .load_snapshot(&snapshot_id)
        .unwrap_err();

    assert_eq!(err.code(), "SNAPSHOT_NOT_FOUND");
    assert_eq!(
        ref_name(&store_a.load_snapshot(&snapshot_id).unwrap()),
        Some("A")
    );
    assert_eq!(
        ref_name(&store_b.load_snapshot(&snapshot_id).unwrap()),
        Some("B")
    );
}

#[test]
fn snapshot_pruning_preserves_trace_segments_and_refmaps() {
    let _guard = HomeGuard::new();
    let store = RefStore::for_session(Some("trace-retention")).unwrap();
    let trace_dir = store.trace_dir();
    crate::trace::ensure_trace_dir(&trace_dir).unwrap();
    let segment = trace_dir.join("1234-5678.jsonl");
    std::fs::write(&segment, b"{}\n").unwrap();
    let refmaps = trace_dir.join("refmaps");
    std::fs::create_dir(&refmaps).unwrap();
    let archived_refmap = refmaps.join("snap-0000.json");
    std::fs::write(&archived_refmap, b"saved refmap").unwrap();
    for index in 0..=MAX_SAVED_SNAPSHOTS {
        let snapshot_id = format!("snap-{index:04}");
        store
            .save_snapshot(&snapshot_id, &map_with(&snapshot_id))
            .unwrap();
        store.set_latest(&snapshot_id).unwrap();
    }
    store
        .save_new_snapshot(&map_with("Trigger pruning"))
        .unwrap();
    assert!(segment.is_file());
    assert_eq!(std::fs::read(archived_refmap).unwrap(), b"saved refmap");
    assert!(!store.snapshots_dir().join("snap-0000").exists());
    assert!(trace_dir.is_dir());
}

#[test]
fn eviction_sweeps_orphans_left_in_snapshots_this_process_never_touched() {
    let _guard = HomeGuard::new();
    let store = RefStore::new().unwrap();

    let survivor = store.save_new_snapshot(&map_with("Survivor")).unwrap();
    let orphan = store
        .snapshots_dir()
        .join(&survivor)
        .join("refmap.json.abandoned.tmp");
    std::fs::write(&orphan, b"orphan").unwrap();
    let aged = std::time::SystemTime::now() - (STALE_TMP_MAX_AGE * 2);
    std::fs::File::options()
        .write(true)
        .open(&orphan)
        .unwrap()
        .set_modified(aged)
        .unwrap();

    for i in 0..=MAX_SAVED_SNAPSHOTS {
        store
            .save_new_snapshot(&map_with(&format!("Fill {i}")))
            .unwrap();
    }

    assert!(
        !orphan.exists(),
        "snapshot ids are one-shot, so an orphan in a directory this process never rewrites \
         is only reachable by the exhaustive sweep that runs with eviction"
    );
}

#[test]
fn eviction_drops_to_the_low_water_mark_rather_than_the_cap() {
    let _guard = HomeGuard::new();
    let store = RefStore::new().unwrap();

    for i in 0..=MAX_SAVED_SNAPSHOTS {
        store
            .save_new_snapshot(&map_with(&format!("Snapshot {i}")))
            .unwrap();
    }

    let retained = std::fs::read_dir(store.snapshots_dir())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .count();

    assert_eq!(
        retained,
        PRUNE_LOW_WATER,
        "eviction goes below the cap so the sort-and-stat pass is amortised across the next \
         {} saves instead of running on every one",
        MAX_SAVED_SNAPSHOTS - PRUNE_LOW_WATER
    );
}
