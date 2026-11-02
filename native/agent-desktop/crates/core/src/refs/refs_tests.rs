use super::*;
use crate::refs::refs_test_support::HomeGuard;
pub(super) fn entry(role: &str, name: Option<&str>) -> RefEntry {
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: role.into(),
            name: name.map(String::from),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash: None,
        },
        capabilities: crate::RefCapabilities {
            states: vec![],
            available_actions: vec!["Click".into()],
        },
        source: crate::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    }
}

#[test]
fn test_allocate_sequential() {
    let mut map = RefMap::new();
    let r1 = map.allocate(entry("button", Some("OK")));
    let r2 = map.allocate(entry("button", Some("OK")));
    assert_eq!(r1, "@e1");
    assert_eq!(r2, "@e2");
    assert_eq!(map.len(), 2);
}

#[test]
fn test_get_missing() {
    let map = RefMap::new();
    assert!(map.get("@e99").is_none());
}

#[test]
fn test_validate_ref_id_accepts_snapshot_qualified_refs() {
    assert!(validate_ref_id("@sabc:e1").is_ok());
    assert!(validate_ref_id("@s8f3k2p9:e14").is_ok());
    assert!(validate_ref_id("@s8f3k2p9:e999").is_ok());
}

#[test]
fn test_validate_ref_id_rejects_bare_element_refs() {
    assert!(validate_ref_id("@e1").is_err());
    assert!(validate_ref_id("@e14").is_err());
    assert!(validate_ref_id("@e999").is_err());
}

#[test]
fn test_validate_ref_id_rejects_malformed_refs() {
    assert!(validate_ref_id("@").is_err());
    assert!(validate_ref_id("e1").is_err());
    assert!(validate_ref_id("@e").is_err());
    assert!(validate_ref_id("@e0").is_err());
    assert!(validate_ref_id("@e0abc").is_err());
    assert!(validate_ref_id("@sabc:e0").is_err());
    assert!(validate_ref_id("1").is_err());
    assert!(validate_ref_id("").is_err());
}

#[test]
fn test_remove_by_root_ref() {
    let mut map = RefMap::new();
    let base = entry("button", Some("OK"));

    map.allocate(base.clone());

    let mut drilled = base;
    drilled.scope.root_ref = Some("@e1".into());
    map.allocate(drilled.clone());
    map.allocate(drilled);
    assert_eq!(map.len(), 3);

    map.remove_by_root_ref("@e1");
    assert_eq!(map.len(), 1);
    assert!(map.get("@e1").is_some());
}

#[test]
fn test_counter_continues_after_skeleton_into_drill_down() {
    let mut map = RefMap::new();
    let skeleton_entry = entry("button", Some("Skeleton"));

    let last_skeleton = (0..10)
        .map(|_| map.allocate(skeleton_entry.clone()))
        .last()
        .unwrap();
    assert_eq!(last_skeleton, "@e10");

    let mut drilled = skeleton_entry;
    drilled.scope.root_ref = Some("@e3".into());

    let first_drilled = map.allocate(drilled.clone());
    let second_drilled = map.allocate(drilled);
    assert_eq!(
        first_drilled, "@e11",
        "counter should continue past skeleton ids, not reset"
    );
    assert_eq!(second_drilled, "@e12");
    assert_eq!(map.len(), 12);

    map.remove_by_root_ref("@e3");
    assert_eq!(
        map.len(),
        10,
        "scoped invalidation should drop only the drill-down refs"
    );
    assert!(map.get("@e3").is_some(), "skeleton @e3 must survive");
}

#[test]
fn test_root_ref_serde_roundtrip() {
    let mut entry = entry("button", None);
    entry.scope.root_ref = Some("@e5".into());
    let json = serde_json::to_string(&entry).unwrap();
    assert!(json.contains("root_ref"));
    let back: RefEntry = serde_json::from_str(&json).unwrap();
    assert_eq!(back.scope.root_ref.as_deref(), Some("@e5"));
}

#[test]
fn drill_replaces_full_snapshot_and_nested_descendants_only() {
    let mut map = RefMap::new();
    let mut allocate = |path: &[usize], owner: Option<&str>| {
        let mut value = entry("button", Some("Target"));
        value.scope.path = path.iter().copied().collect();
        value.scope.root_ref = owner.map(str::to_string);
        value.scope.path_is_absolute = owner.is_some();
        map.allocate(value)
    };
    let root = allocate(&[0], None);
    let full_child = allocate(&[0, 0], None);
    let drilled_child = allocate(&[0, 0], Some(&root));
    let nested_child = allocate(&[0, 0, 0], Some(&drilled_child));
    let sibling = allocate(&[1], None);
    let mut other_window = map.get(&full_child).unwrap().clone();
    other_window.source.source_window_id = Some("w-2".into());
    let other_window = map.allocate(other_window);
    map.remove_by_root_ref(&root);
    assert!(map.get(&root).is_some());
    assert!(map.get(&sibling).is_some());
    assert!(map.get(&other_window).is_some());
    for removed in [full_child, drilled_child, nested_child] {
        assert!(
            map.get(&removed).is_none(),
            "obsolete ref {removed} survived"
        );
    }
}

#[test]
fn test_save_load_roundtrip_with_home_override() {
    let _guard = HomeGuard::new();
    let mut map = RefMap::new();
    let bounds = crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    map.allocate(RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(7),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some("Send".into()),
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
            available_actions: vec!["Click".into()],
        },
        source: crate::RefSource {
            source_app: Some("TestApp".into()),
            source_window_id: None,
            source_window_title: Some("Test Window".into()),
            source_window_bounds_hash: None,
            source_surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    });
    map.save().expect("save should succeed under HomeGuard");

    let loaded = RefMap::load().expect("load should succeed");
    assert_eq!(loaded.len(), 1);
    let entry = loaded.get("@e1").unwrap();
    assert_eq!(entry.process.pid, 7);
    assert_eq!(entry.identity.role, "button");
    assert_eq!(entry.identity.name.as_deref(), Some("Send"));
}

#[test]
fn test_snapshot_ids_are_compact_and_valid() {
    let id = new_snapshot_id();

    assert!(id.starts_with('s'));
    assert!(id.len() <= 14, "snapshot id should stay token-light: {id}");
    validate_snapshot_id(&id).unwrap();
}

#[test]
fn test_base36_encoding() {
    assert_eq!(base36(0), "0000");
    assert_eq!(base36(35), "000z");
    assert_eq!(base36(36), "0010");
    assert_eq!(base36(36 * 36 * 36 + 35), "100z");
    assert!(base36(u64::MAX).len() >= 4);
}

#[test]
fn test_new_snapshot_id_passes_validation() {
    for _ in 0..256 {
        let id = new_snapshot_id();
        validate_snapshot_id(&id).expect("generated snapshot id must validate");
    }
}

#[test]
fn test_validate_snapshot_id_rejects_bad_values() {
    assert!(validate_snapshot_id("").is_err());
    assert!(validate_snapshot_id("s").is_err());
    assert!(validate_snapshot_id(&format!("s{}", "x".repeat(64))).is_err());
    assert!(validate_snapshot_id("bad/id").is_err());
}

#[test]
fn test_save_oversize_preserves_previous_file() {
    let _guard = HomeGuard::new();
    let store = crate::RefStore::new().unwrap();

    let mut original = RefMap::new();
    original.allocate(entry("button", Some("Original")));
    let snapshot_id = store.save_new_snapshot(&original).expect("baseline save");

    let mut oversize = RefMap::new();
    let big = "x".repeat(2048);
    for _ in 0..600 {
        oversize.allocate(entry("button", Some(&big)));
    }
    let result = store.save_snapshot(&snapshot_id, &oversize);
    assert!(result.is_err(), "oversize save must reject");

    let reloaded = store
        .load_snapshot(&snapshot_id)
        .expect("previous file must still load");
    assert_eq!(reloaded.len(), 1);
    let entry = reloaded.get("@e1").unwrap();
    assert_eq!(entry.identity.name.as_deref(), Some("Original"));
}

#[cfg(unix)]
#[test]
fn test_write_private_file_ignores_stale_predictable_tmp_symlink() {
    let dir = std::env::temp_dir().join(format!(
        "agent-desktop-ref-symlink-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = dir.join("refmap.json");
    let target = dir.join("target.json");
    let stale = path.with_extension("tmp");
    std::fs::write(&target, b"existing").unwrap();
    std::os::unix::fs::symlink(&target, &stale).unwrap();

    write_private_file(&path, b"new").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"new");
    assert_eq!(std::fs::read(&target).unwrap(), b"existing");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn test_root_ref_none_omitted() {
    let entry = entry("button", None);
    let json = serde_json::to_string(&entry).unwrap();
    assert!(!json.contains("root_ref"));
}

#[test]
fn test_write_private_file_cleans_tmp_when_rename_fails() {
    let dir = std::env::temp_dir().join(format!(
        "agent-desktop-ref-renamefail-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let path = dir.join("blocked");
    std::fs::create_dir_all(path.join("child")).unwrap();

    let result = write_private_file(&path, b"new");
    assert!(result.is_err());
    assert!(!dir.join("blocked.tmp").exists());
    let _ = std::fs::remove_dir_all(dir);
}
