use super::*;
use crate::refs::refs_test_support::HomeGuard;

#[test]
fn trace_dir_points_under_session_base() {
    let _guard = HomeGuard::new();
    let store = RefStore::for_session(Some("run-42")).unwrap();
    assert_eq!(store.trace_dir(), store.base_dir().join("trace"));
}

#[test]
fn trace_dir_accessors_create_no_directories() {
    let _guard = HomeGuard::new();
    let store = RefStore::for_session(Some("run-42")).unwrap();
    let _ = store.trace_dir();
    assert!(
        !store.trace_dir().exists(),
        "trace_dir accessor must not create directories"
    );
}
