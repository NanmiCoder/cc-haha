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

#[test]
fn a_storage_probe_uses_private_permissions_and_leaves_no_session() {
    const CHILD_FLAG: &str = "AGENT_DESKTOP_STATUS_PROBE_TEST_CHILD";
    if std::env::var_os(CHILD_FLAG).is_none() {
        // Set a permissive umask only in the test child.
        let output = std::process::Command::new("sh")
            .args(["-c", "umask 022; exec \"$@\"", "status-probe-test"])
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "session::tree::tests::a_storage_probe_uses_private_permissions_and_leaves_no_session",
            ])
            .env(CHILD_FLAG, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed; 0 failed"),
            "storage probe child failed\nstdout: {stdout}\nstderr: {}",
            String::from_utf8_lossy(&output.stderr),
        );
        return;
    }

    let guard = HomeGuard::new();
    super::check_storage().expect("a healthy store is writable with umask 022");
    let sessions = guard.path().join(".agent-desktop/sessions");
    assert!(sessions.read_dir().unwrap().next().is_none());
}
