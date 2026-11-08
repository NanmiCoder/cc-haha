//! Namespace isolation between the default store and a named session:
//! neither may read, overwrite, or discover the other's snapshots, and an
//! explicit snapshot id stays inside the namespace that minted it.

use super::*;

#[test]
fn sessions_are_isolated_from_default_store() {
    let _guard = HomeGuard::new();
    let default_store = RefStore::new().unwrap();
    let session_a = RefStore::for_session(Some("agent-a")).unwrap();
    let session_b = RefStore::for_session(Some("agent-b")).unwrap();

    let default_id = default_store
        .save_new_snapshot(&map_with("Default"))
        .unwrap();
    let session_id = session_a.save_new_snapshot(&map_with("Session A")).unwrap();

    assert_eq!(default_store.load(None).unwrap().len(), 1);
    assert_eq!(
        ref_name(&default_store.load(Some(&default_id)).unwrap()),
        Some("Default")
    );
    assert_eq!(
        ref_name(&session_a.load(Some(&session_id)).unwrap()),
        Some("Session A")
    );
    assert!(session_b.load(None).is_err());
    assert_ne!(
        default_store.latest_snapshot_id().unwrap(),
        session_a.latest_snapshot_id().unwrap()
    );
}

#[test]
fn explicit_snapshot_id_remains_in_its_session_namespace() {
    let _guard = HomeGuard::new();
    let default_store = RefStore::new().unwrap();
    let session_a = RefStore::for_session(Some("agent-a")).unwrap();
    let session_b = RefStore::for_session(Some("agent-b")).unwrap();

    let snapshot_id = session_a.save_new_snapshot(&map_with("Session A")).unwrap();

    assert!(default_store.load(Some(&snapshot_id)).is_err());
    assert!(session_b.load(Some(&snapshot_id)).is_err());
    assert_eq!(
        ref_name(&session_a.load(Some(&snapshot_id)).unwrap()),
        Some("Session A")
    );
    assert!(default_store.load(None).is_err());
    assert!(session_b.load(None).is_err());
}

#[test]
fn update_existing_snapshot_cannot_cross_session_namespaces() {
    let _guard = HomeGuard::new();
    let default_store = RefStore::new().unwrap();
    let session_a = RefStore::for_session(Some("agent-a")).unwrap();

    let snapshot_id = session_a.save_new_snapshot(&map_with("Session A")).unwrap();
    let err = default_store
        .update_existing_snapshot(&snapshot_id, "@e1", &entry("Session A"), |_| Ok(()))
        .unwrap_err();

    assert_eq!(err.code(), "SNAPSHOT_NOT_FOUND");
    assert_eq!(
        ref_name(&session_a.load(Some(&snapshot_id)).unwrap()),
        Some("Session A")
    );
    assert!(default_store.latest_snapshot_id().unwrap().is_none());
    assert_eq!(
        session_a.latest_snapshot_id().unwrap().as_deref(),
        Some(snapshot_id.as_str())
    );
}

#[test]
fn duplicate_explicit_snapshot_ids_remain_session_scoped() {
    let _guard = HomeGuard::new();
    let default_store = RefStore::new().unwrap();
    let session_a = RefStore::for_session(Some("agent-a")).unwrap();
    let session_b = RefStore::for_session(Some("agent-b")).unwrap();

    session_a
        .save_snapshot("sdup1", &map_with("Session A"))
        .unwrap();
    session_b
        .save_snapshot("sdup1", &map_with("Session B"))
        .unwrap();

    let err = default_store.load(Some("sdup1")).unwrap_err();

    assert_eq!(err.code(), "SNAPSHOT_NOT_FOUND");
    assert_eq!(
        ref_name(&session_a.load(Some("sdup1")).unwrap()),
        Some("Session A")
    );
    assert_eq!(
        ref_name(&session_b.load(Some("sdup1")).unwrap()),
        Some("Session B")
    );
}

#[test]
fn default_store_does_not_discover_session_snapshots() {
    let _guard = HomeGuard::new();
    let default_store = RefStore::new().unwrap();
    let session_a = RefStore::for_session(Some("agent-a")).unwrap();

    session_a
        .save_snapshot("sdup2", &map_with("Session A"))
        .unwrap();
    let invalid_base = default_store.base_dir.join("sessions").join("bad.session");
    let invalid_path = RefStore::snapshot_path_for_base(&invalid_base, "sdup2");
    std::fs::create_dir_all(invalid_path.parent().unwrap()).unwrap();
    std::fs::write(
        invalid_path,
        map_with("Invalid").serialize_with_size_check().unwrap(),
    )
    .unwrap();

    let err = default_store.load(Some("sdup2")).unwrap_err();
    assert_eq!(err.code(), "SNAPSHOT_NOT_FOUND");
    assert_eq!(
        ref_name(&session_a.load(Some("sdup2")).unwrap()),
        Some("Session A")
    );
}
