#![cfg(unix)]

use std::{
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use super::*;

/// Blocks until the parent closes this child's stdin, which happens when the
/// parent kills this process, drops the pipe, or exits for any reason including
/// a panic. A holder that slept for a fixed span instead would release its lease
/// on a schedule the parent has to out-race, and a parent thread starved past
/// that span observes a free lock and fails an assertion about contention that
/// was true when it was written.
fn hold_until_parent_releases() {
    use std::io::Read;

    let mut released = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut released);
}

/// Waits for a child's readiness marker on a deliberately generous budget. A
/// holder may have to start further test binaries before it can signal, and a
/// loaded machine can starve this thread between polls; nothing downstream
/// depends on how long the wait took, because the holder now keeps its lease
/// until it is released explicitly rather than until a timer expires.
fn wait_for_marker(path: &std::path::Path) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !path.is_file() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    path.is_file()
}

static INTERACTION_LEASE_TEST_LOCK: Mutex<()> = Mutex::new(());

fn interaction_lease_test_guard() -> MutexGuard<'static, ()> {
    INTERACTION_LEASE_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn test_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "agent-desktop-interaction-{label}-{}",
        crate::refs::new_snapshot_id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn a_second_lease_times_out_and_drop_releases_the_first() {
    let _test_guard = interaction_lease_test_guard();
    let root = test_root("contention");
    let first = acquire_unix_interaction_lease_at(Deadline::after(100).unwrap(), &root).unwrap();
    let deadline = Deadline::after(10).unwrap();
    let error = match acquire_unix_interaction_lease_at(deadline, &root) {
        Ok(_) => panic!("contended lease unexpectedly acquired"),
        Err(error) => error,
    };
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(
        error.details.as_ref().unwrap()["contention_count"]
            .as_u64()
            .unwrap()
            >= 1
    );
    assert!(deadline.elapsed() < Duration::from_secs(5));
    drop(first);
    acquire_unix_interaction_lease_at(Deadline::after(100).unwrap(), &root).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_recovery_lease_retains_file_and_process_ownership_after_parent_drop() {
    let _test_guard = interaction_lease_test_guard();
    let root = test_root("recovery");
    let original =
        acquire_unix_interaction_lease_at(Deadline::after(1_000).unwrap(), &root).unwrap();
    let recovery = original.with_deadline(Deadline::detached_after(5_000).unwrap());
    let inherited = recovery.duplicate_inheritable_fd().unwrap();
    drop(original);
    assert!(FileLock::is_held(&interaction_lock_path_at(&root).unwrap()));
    let error = acquire_unix_interaction_lease_at(Deadline::after(10).unwrap(), &root)
        .err()
        .expect("the recovery lease must retain the process guard");
    assert_eq!(
        error.details.unwrap()["kind"],
        "interaction_process_lock_timeout"
    );
    assert!(!recovery.deadline().is_expired());
    drop(recovery);
    assert!(FileLock::is_held(&interaction_lock_path_at(&root).unwrap()));
    drop(inherited);
    acquire_unix_interaction_lease_at(Deadline::after(1_000).unwrap(), &root).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn subprocess_holder() {
    let Some(ready_path) = std::env::var_os("AGENT_DESKTOP_LOCK_HELPER_READY") else {
        return;
    };
    let root = PathBuf::from(std::env::var_os("AGENT_DESKTOP_LOCK_HELPER_ROOT").unwrap());
    let _lease = acquire_unix_interaction_lease_at(Deadline::after(5_000).unwrap(), &root).unwrap();
    std::fs::write(ready_path, b"ready").unwrap();
    hold_until_parent_releases();
}

#[test]
fn subprocess_adopted_holder() {
    use std::os::fd::RawFd;

    let Some(ready_path) = std::env::var_os("AGENT_DESKTOP_ADOPT_HELPER_READY") else {
        return;
    };
    let root = PathBuf::from(std::env::var_os("AGENT_DESKTOP_ADOPT_HELPER_ROOT").unwrap());
    let raw_fd = std::env::var("AGENT_DESKTOP_ADOPT_HELPER_FD")
        .unwrap()
        .parse::<RawFd>()
        .unwrap();
    let _lease =
        adopt_inherited_unix_interaction_lease_at(raw_fd, Deadline::after(5_000).unwrap(), &root)
            .unwrap();
    let filter = "session::interaction_lease::tests::subprocess_inherited_fd_is_closed";
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg(filter)
        .arg("--nocapture")
        .env("AGENT_DESKTOP_CLOSED_HELPER_FD", raw_fd.to_string())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed; 0 failed"),
        "child `{filter}` must run exactly that test and pass\nstdout: {stdout}\nstderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::write(ready_path, b"ready").unwrap();
    hold_until_parent_releases();
}

#[test]
fn subprocess_inherited_fd_is_closed() {
    let Some(raw_fd) = std::env::var_os("AGENT_DESKTOP_CLOSED_HELPER_FD") else {
        return;
    };
    let raw_fd = raw_fd
        .to_string_lossy()
        .parse::<std::os::fd::RawFd>()
        .unwrap();
    assert_eq!(unsafe { libc::fcntl(raw_fd, libc::F_GETFD) }, -1);
}

#[test]
fn different_home_subprocess_contends_and_crash_releases() {
    let _test_guard = interaction_lease_test_guard();
    let token = crate::refs::new_snapshot_id();
    let directory = std::env::temp_dir().join(format!("agent-desktop-lock-proof-{token}"));
    let interaction_root = directory.join("runtime-root");
    let other_home = directory.join("other-home");
    let ready = directory.join("ready");
    std::fs::create_dir_all(&other_home).unwrap();
    std::fs::create_dir_all(&interaction_root).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("session::interaction_lease::tests::subprocess_holder")
        .arg("--nocapture")
        .env("HOME", &other_home)
        .env("AGENT_DESKTOP_LOCK_HELPER_READY", &ready)
        .env("AGENT_DESKTOP_LOCK_HELPER_ROOT", &interaction_root)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    assert!(
        wait_for_marker(&ready),
        "subprocess did not acquire interaction lease"
    );
    let error =
        match acquire_unix_interaction_lease_at(Deadline::after(25).unwrap(), &interaction_root) {
            Ok(_) => panic!("different HOME subprocess bypassed interaction lock"),
            Err(error) => error,
        };
    assert_eq!(error.code, ErrorCode::Timeout);
    let _ = child.kill();
    reap_child(&mut child, Duration::from_secs(60));
    acquire_unix_interaction_lease_at(Deadline::after(1_000).unwrap(), &interaction_root).unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn inherited_descriptor_survives_parent_drop_and_crash_releases() {
    use std::os::fd::AsRawFd;

    let _test_guard = interaction_lease_test_guard();
    let root = test_root("inherited");
    let ready = root.join("adopted-ready");
    let lease = acquire_unix_interaction_lease_at(Deadline::after(1_000).unwrap(), &root).unwrap();
    let inherited = lease.duplicate_inheritable_fd().unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("session::interaction_lease::tests::subprocess_adopted_holder")
        .arg("--nocapture")
        .env("AGENT_DESKTOP_ADOPT_HELPER_READY", &ready)
        .env("AGENT_DESKTOP_ADOPT_HELPER_ROOT", &root)
        .env(
            "AGENT_DESKTOP_ADOPT_HELPER_FD",
            inherited.as_raw_fd().to_string(),
        )
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let ready_deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !ready.is_file() && std::time::Instant::now() < ready_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        wait_for_marker(&ready),
        "subprocess did not adopt interaction lease"
    );
    drop(inherited);
    drop(lease);
    let error = acquire_unix_interaction_lease_at(Deadline::after(25).unwrap(), &root)
        .err()
        .expect("adopted descriptor must retain the lease");
    assert_eq!(error.code, ErrorCode::Timeout);
    child.kill().unwrap();
    reap_child(&mut child, Duration::from_secs(60));
    acquire_unix_interaction_lease_at(Deadline::after(1_000).unwrap(), &root).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn inherited_descriptor_must_match_canonical_lock_identity() {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    let _test_guard = interaction_lease_test_guard();
    let root = test_root("inherited-mismatch");
    let lease = acquire_unix_interaction_lease_at(Deadline::after(1_000).unwrap(), &root).unwrap();
    let unrelated_path = root.join("unrelated.lock");
    let unrelated = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&unrelated_path)
        .unwrap();
    drop(lease);
    let error = adopt_inherited_unix_interaction_lease_at(
        unrelated.as_raw_fd(),
        Deadline::after(100).unwrap(),
        &root,
    )
    .err()
    .expect("an unrelated descriptor must be rejected");
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn inherited_descriptor_serializes_threads_in_one_host_process() {
    use std::os::fd::AsRawFd;

    let _test_guard = interaction_lease_test_guard();
    let root = test_root("inherited-threads");
    let original =
        acquire_unix_interaction_lease_at(Deadline::after(1_000).unwrap(), &root).unwrap();
    let inherited = original.duplicate_inheritable_fd().unwrap();
    drop(original);
    let first = adopt_inherited_unix_interaction_lease_at(
        inherited.as_raw_fd(),
        Deadline::after(1_000).unwrap(),
        &root,
    )
    .unwrap();
    let raw_fd = inherited.as_raw_fd();
    let thread_root = root.clone();
    let contender = std::thread::spawn(move || {
        adopt_inherited_unix_interaction_lease_at(
            raw_fd,
            Deadline::after(25).unwrap(),
            &thread_root,
        )
        .err()
        .expect("concurrent adoption must not share a critical section")
    });

    let error = contender.join().unwrap();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.details.as_ref().unwrap()["kind"],
        "interaction_process_lock_timeout"
    );
    drop(first);
    adopt_inherited_unix_interaction_lease_at(
        inherited.as_raw_fd(),
        Deadline::after(1_000).unwrap(),
        &root,
    )
    .unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

/// Waits for a killed holder to be reaped. The budget is generous because the
/// assertion is meant to catch a child that never exits, not a scheduler that
/// took its time getting back to this thread; a tight budget turns ordinary
/// load into a failure that reads like a stuck subprocess.
fn reap_child(child: &mut std::process::Child, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if child.try_wait().unwrap().is_some() {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "lock-holder subprocess did not exit after kill"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
#[test]
fn runtime_directory_is_private_and_rejects_symlinks() {
    use std::os::unix::fs::PermissionsExt;

    let token = crate::refs::new_snapshot_id();
    let root = std::env::temp_dir().join(format!("agent-desktop-runtime-proof-{token}"));
    let runtime = root.join("runtime");
    std::fs::create_dir_all(&root).unwrap();
    let uid = unsafe { libc::geteuid() };
    ensure_unix_runtime_directory(&runtime, uid).unwrap();
    let mode = std::fs::metadata(&runtime).unwrap().permissions().mode();
    assert_eq!(mode & 0o077, 0);
    std::fs::remove_dir(&runtime).unwrap();
    std::os::unix::fs::symlink(&root, &runtime).unwrap();
    assert!(ensure_unix_runtime_directory(&runtime, uid).is_err());
    std::fs::remove_dir_all(&root).unwrap();
}
