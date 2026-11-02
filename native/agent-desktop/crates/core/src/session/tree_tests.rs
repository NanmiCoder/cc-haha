use crate::AppError;
use crate::refs::refs_test_support::HomeGuard;
use crate::session::{ArtifactsMode, SessionTraceMode, StartSessionOptions, start_session};
use std::os::unix::fs::PermissionsExt;

fn options() -> StartSessionOptions {
    StartSessionOptions {
        name: None,
        trace: SessionTraceMode::On,
        artifacts: ArtifactsMode::Events,
    }
}

#[test]
fn a_session_does_not_start_in_a_state_root_that_group_users_can_write() {
    let guard = HomeGuard::new();
    let root = guard.path().join(".agent-desktop");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o775)).unwrap();
    let error = start_session(options()).expect_err("a shared root is refused");
    assert!(
        matches!(&error, AppError::Internal(message) if message.contains("accessible by group or other"))
    );
    assert!(!root.join("sessions").exists());
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    start_session(options()).expect("a private root starts a session");
}
