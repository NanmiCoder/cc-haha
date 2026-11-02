use super::*;
use crate::{
    ErrorCode,
    adapter::SnapshotSurface,
    refs::refs_test_support::HomeGuard,
    refs::{RefEntry, RefMap},
};
fn entry(name: &str) -> RefEntry {
    let bounds = crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(7),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some(name.into()),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: Some(bounds),
            bounds_hash: bounds.bounds_hash(),
        },
        capabilities: crate::RefCapabilities {
            states: vec![],
            available_actions: vec![crate::actions::capability::CLICK.into()],
        },
        source: crate::RefSource {
            source_app: Some("TestApp".into()),
            source_window_id: None,
            source_window_title: Some("Test Window".into()),
            source_window_bounds_hash: None,
            source_surface: SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    }
}

fn map_with(name: &str) -> RefMap {
    let mut map = RefMap::new();
    map.allocate(entry(name));
    map
}

fn ref_name(map: &RefMap) -> Option<&str> {
    map.get("@e1")
        .and_then(|entry| entry.identity.name.as_deref())
}

#[test]
fn snapshot_roundtrip_updates_latest_pointer() {
    let _guard = HomeGuard::new();
    let store = RefStore::new().unwrap();
    let map = map_with("Send");

    let snapshot_id = store.save_new_snapshot(&map).unwrap();

    assert_eq!(
        store.latest_snapshot_id().unwrap().as_deref(),
        Some(snapshot_id.as_str())
    );
    assert_eq!(store.load(Some(&snapshot_id)).unwrap().len(), 1);
    assert_eq!(store.load(None).unwrap().len(), 1);
}

#[test]
fn load_ref_uses_qualified_identity_and_never_crosses_sessions() {
    let _guard = HomeGuard::new();
    let store = RefStore::for_session(Some("debug-session")).unwrap();
    let snapshot = store.save_new_snapshot(&map_with("Target")).unwrap();
    let qualified = format!("@{snapshot}:e1");
    assert_eq!(store.load_ref(&qualified).unwrap(), entry("Target"));
    assert_eq!(store.load_ref("@e1").unwrap_err().code(), "INVALID_ARGS");
    assert_eq!(
        store
            .load_ref(&format!("@{snapshot}:e2"))
            .unwrap_err()
            .code(),
        "STALE_REF"
    );
    assert_eq!(
        RefStore::new()
            .unwrap()
            .load_ref(&qualified)
            .unwrap_err()
            .code(),
        "SNAPSHOT_NOT_FOUND"
    );
}

#[test]
fn snapshots_saved_by_eight_threads_in_turn_are_all_preserved() {
    let _guard = HomeGuard::new();
    let store = RefStore::new().unwrap();
    let turn = std::sync::Arc::new((std::sync::Mutex::new(0_usize), std::sync::Condvar::new()));
    let mut handles = Vec::new();
    for writer in 0..8 {
        let store = store.clone();
        let turn = std::sync::Arc::clone(&turn);
        handles.push(std::thread::spawn(move || {
            let (counter, changed) = &*turn;
            let mut current = counter.lock().unwrap();
            while *current != writer {
                current = changed.wait(current).unwrap();
            }
            let id = store
                .save_new_snapshot(&map_with(&format!("Snapshot {writer}")))
                .unwrap();
            *current = writer + 1;
            changed.notify_all();
            id
        }));
    }

    let ids = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();

    let distinct = ids.iter().collect::<std::collections::HashSet<_>>();
    assert_eq!(distinct.len(), 8);
    for (writer, id) in ids.iter().enumerate() {
        let saved = store.load_snapshot(id).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(
            ref_name(&saved),
            Some(format!("Snapshot {writer}").as_str())
        );
    }
    assert_eq!(
        store.latest_snapshot_id().unwrap().as_deref(),
        Some(ids[7].as_str())
    );
}

#[test]
fn save_new_snapshot_waits_on_a_held_store_lock() {
    let _guard = HomeGuard::new();
    let store = RefStore::new().unwrap();
    let held = RefStoreLock::acquire(&store.lock_path()).unwrap();
    let clock = crate::wait::deadline::VirtualClock::freeze();

    let AppError::Adapter(error) = store.save_new_snapshot(&map_with("Blocked")).unwrap_err()
    else {
        panic!("a contended save must fail with an adapter error");
    };

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.details.unwrap()["kind"], "lock_timeout");
    assert_eq!(clock.elapsed(), std::time::Duration::from_millis(2_000));
    assert!(store.latest_snapshot_id().unwrap().is_none());

    drop(held);
    let saved = store.save_new_snapshot(&map_with("Unblocked")).unwrap();

    assert_eq!(store.load_snapshot(&saved).unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn read_snapshot_rejects_symlinked_refmap() {
    let _guard = HomeGuard::new();
    let store = RefStore::new().unwrap();

    store.save_snapshot("ssym1", &map_with("Original")).unwrap();
    let path = store.snapshot_path("ssym1");
    let target = store.base_dir.join("symlink-target-refmap.json");
    std::fs::write(
        target.as_path(),
        map_with("Symlinked").serialize_with_size_check().unwrap(),
    )
    .unwrap();
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();

    let err = store.load(Some("ssym1")).unwrap_err();

    assert_eq!(err.code(), "INTERNAL");
}

#[cfg(unix)]
#[test]
fn read_latest_rejects_symlinked_pointer() {
    let _guard = HomeGuard::new();
    let store = RefStore::new().unwrap();

    let snapshot_id = store.save_new_snapshot(&map_with("Original")).unwrap();
    let latest = store.latest_path();
    let target = store.base_dir.join("latest-target");
    std::fs::write(&target, snapshot_id).unwrap();
    std::fs::remove_file(&latest).unwrap();
    std::os::unix::fs::symlink(&target, &latest).unwrap();

    let err = store.load_latest().unwrap_err();

    assert_eq!(err.code(), "INTERNAL");
    assert!(store.latest_snapshot_id().is_err());
}

#[test]
fn update_existing_snapshot_does_not_promote_latest_pointer() {
    let _guard = HomeGuard::new();
    let store = RefStore::new().unwrap();

    let first_id = store.save_new_snapshot(&map_with("First")).unwrap();
    let second_id = store.save_new_snapshot(&map_with("Second")).unwrap();

    store
        .update_existing_snapshot(&first_id, "@e1", &entry("First"), |map| {
            map.allocate(entry("First Child"));
            Ok(())
        })
        .unwrap();

    assert_eq!(
        store.latest_snapshot_id().unwrap().as_deref(),
        Some(second_id.as_str())
    );
    assert_eq!(store.load(Some(&first_id)).unwrap().len(), 2);
}

#[test]
fn default_store_migrates_legacy_latest_refmap() {
    let _guard = HomeGuard::new();
    map_with("Legacy").save().unwrap();

    let store = RefStore::new().unwrap();
    let loaded = store.load_latest().unwrap();

    assert_eq!(loaded.len(), 1);
    assert!(store.latest_snapshot_id().unwrap().is_some());
}

#[test]
fn session_store_does_not_migrate_global_legacy_refmap() {
    let _guard = HomeGuard::new();
    map_with("Legacy").save().unwrap();

    let store = RefStore::for_session(Some("fresh-agent")).unwrap();
    let err = store.load(None).unwrap_err();

    assert_eq!(err.code(), "SNAPSHOT_NOT_FOUND");
    assert!(store.latest_snapshot_id().unwrap().is_none());
}

#[test]
fn stale_tmp_files_are_swept_and_fresh_ones_kept() {
    let _guard = HomeGuard::new();
    let store = RefStore::new().unwrap();
    let snapshot_id = store.save_new_snapshot(&map_with("Send")).unwrap();
    let base_tmp = store.base_dir.join("latest_snapshot_id.tmp");
    let snapshot_tmp = store.snapshots_dir().join("dead.tmp");
    let refmap_tmp = store.snapshots_dir().join(&snapshot_id).join("refmap.tmp");
    std::fs::write(&base_tmp, b"orphan").unwrap();
    std::fs::write(&snapshot_tmp, b"orphan").unwrap();
    std::fs::write(&refmap_tmp, b"orphan").unwrap();

    store.remove_tmp_files_older_than(std::time::Duration::ZERO);

    assert!(!base_tmp.exists());
    assert!(!snapshot_tmp.exists());
    assert!(!refmap_tmp.exists());
    assert!(store.snapshot_path(&snapshot_id).is_file());

    std::fs::write(&base_tmp, b"fresh").unwrap();
    store.remove_tmp_files_older_than(STALE_TMP_MAX_AGE);

    assert!(base_tmp.exists());
}

#[path = "refs_store_pruning_tests.rs"]
mod pruning_tests;

#[path = "refs_store_session_tests.rs"]
mod session_tests;
