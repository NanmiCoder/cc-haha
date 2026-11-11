use std::path::{Path, PathBuf};
use std::time::Duration;

use super::*;
use super::{directory, identity};
use crate::system::fixture::test_support::with_interaction_lease_test_lock;

/// Canonicalized before returning: `validate_final_path` compares a lease
/// directory's resolved final path against the literal root it was joined
/// from, so a scratch root that itself sits behind an ambient reparse point
/// in `%TEMP%`'s chain (e.g. a redirected profile) would otherwise make
/// every legitimate test directory look tampered.
pub(super) fn scratch_root(label: &str) -> PathBuf {
    let unique = format!(
        "agent-desktop-interaction-lease-{label}-{}-{}",
        std::process::id(),
        unique_token()
    );
    let root = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&root).unwrap();
    directory::strip_extended_prefix(&std::fs::canonicalize(&root).unwrap())
}

fn unique_token() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    nanos ^ COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn wait_for_marker(path: &Path) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !path.is_file() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    path.is_file()
}

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

fn hold_until_parent_releases() {
    use std::io::Read;

    let mut released = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut released);
}

/// Re-exec target: acquires on the root its parent passed and signals
/// readiness by writing the marker file, then blocks until the parent
/// closes its stdin (kill, drop, or exit). Guarded by an env-var presence
/// check so it is a no-op under an ordinary `cargo test` run.
#[test]
fn subprocess_holder() {
    let Some(ready_path) = std::env::var_os("AGENT_DESKTOP_WIN_LOCK_HELPER_READY") else {
        return;
    };
    let root = PathBuf::from(std::env::var_os("AGENT_DESKTOP_WIN_LOCK_HELPER_ROOT").unwrap());
    let _lease = acquire_at(&root, Deadline::after(5_000).unwrap()).unwrap();
    std::fs::write(ready_path, b"ready").unwrap();
    hold_until_parent_releases();
}

#[test]
fn self_acquire_succeeds_and_drop_releases_it() {
    with_interaction_lease_test_lock(|| {
        let root = scratch_root("self-acquire");
        let first = acquire_at(&root, Deadline::after(1_000).unwrap()).unwrap();
        drop(first);
        acquire_at(&root, Deadline::after(1_000).unwrap()).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    });
}

#[test]
fn cross_process_contention_times_out_with_lock_timeout_kind() {
    with_interaction_lease_test_lock(|| {
        let root = scratch_root("cross-process");
        let ready = root.join("ready");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("system::interaction_lease::tests::subprocess_holder")
            .arg("--nocapture")
            .env("AGENT_DESKTOP_WIN_LOCK_HELPER_READY", &ready)
            .env("AGENT_DESKTOP_WIN_LOCK_HELPER_ROOT", &root)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        assert!(
            wait_for_marker(&ready),
            "subprocess did not acquire the interaction lease"
        );

        let error = match acquire_at(&root, Deadline::after(50).unwrap()) {
            Ok(_) => panic!("contended lease unexpectedly acquired"),
            Err(error) => error,
        };
        assert_eq!(error.code, ErrorCode::Timeout);
        let details = error.details.as_ref().unwrap();
        assert_eq!(details["kind"], "lock_timeout");
        assert!(details["contention_count"].as_u64().unwrap() >= 1);

        let _ = child.kill();
        reap_child(&mut child, Duration::from_secs(60));
        acquire_at(&root, Deadline::after(1_000).unwrap()).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    });
}

/// A second in-process acquire refuses through `ProcessLeaseGuard` before the
/// file is ever opened, which is a different shape from cross-process
/// contention: `CreateFileW` with `dwShareMode = 0` also refuses a second
/// open from the *same* process, so asserting the file-lock kind here would
/// be untestable - this proves the in-process guard is what actually fires.
#[test]
fn in_process_second_acquire_times_out_with_process_lock_kind() {
    with_interaction_lease_test_lock(|| {
        let root = scratch_root("in-process");
        let first = acquire_at(&root, Deadline::after(1_000).unwrap()).unwrap();
        let error = match acquire_at(&root, Deadline::after(50).unwrap()) {
            Ok(_) => panic!("in-process double acquire unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(
            error.details.as_ref().unwrap()["kind"],
            "interaction_process_lock_timeout"
        );
        drop(first);
        acquire_at(&root, Deadline::after(1_000).unwrap()).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    });
}

/// A lease acquired after real file contention reports the count it earned,
/// not a hardcoded zero. **Invert-verified**: switching `acquire_impl` to
/// `InteractionLease::guarded(deadline, guard)` makes this assertion fail
/// (`contention_count()` reads back `0`); restoring
/// `guarded_with_contention` makes it pass again.
#[test]
fn success_path_reports_earned_contention_count() {
    with_interaction_lease_test_lock(|| {
        let root = scratch_root("earned-contention");
        let path = canonical_lock_path_at(&root).unwrap();
        directory::ensure_private(lock_directory(&path).unwrap()).unwrap();
        let wide = identity::to_wide(&path);
        let holder = unsafe {
            windows_sys::Win32::Storage::FileSystem::CreateFileW(
                wide.as_ptr(),
                windows_sys::Win32::Foundation::GENERIC_READ
                    | windows_sys::Win32::Foundation::GENERIC_WRITE,
                0,
                std::ptr::null(),
                windows_sys::Win32::Storage::FileSystem::OPEN_ALWAYS,
                windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(holder, windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE);
        let holder_value = holder as isize;
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(holder_value as HANDLE);
            }
        });

        let lease = acquire_at(&root, Deadline::after(2_000).unwrap()).unwrap();
        assert!(lease.contention_count() >= 1);
        releaser.join().unwrap();
        drop(lease);
        std::fs::remove_dir_all(&root).unwrap();
    });
}

/// A lease that queued behind another holder's in-process
/// [`agent_desktop_core::ProcessLeaseGuard`] reports that queueing too, not
/// only file-level contention. `WindowsLeaseGuard` drops its `handle` field
/// before its `_process` field, so the first lease's file handle is already
/// closed by the time its process guard releases - the second acquire's own
/// file open therefore sees zero file-level contention here, and every tick
/// this test observes comes from the process guard alone. **Invert-verified**:
/// dropping `acquire_impl`'s `saturating_add(process_contention)` back to
/// `file_contention` alone makes this assertion fail (`contention_count()`
/// reads back `0`); restoring it makes it pass again.
#[test]
fn success_path_includes_process_guard_contention() {
    with_interaction_lease_test_lock(|| {
        let root = scratch_root("process-guard-contention");
        let first = acquire_at(&root, Deadline::after(2_000).unwrap()).unwrap();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            drop(first);
        });

        let lease = acquire_at(&root, Deadline::after(2_000).unwrap()).unwrap();
        assert!(
            lease.contention_count() >= 1,
            "a lease that queued behind another holder's in-process guard must report that \
             queueing, not just file-level contention"
        );
        releaser.join().unwrap();
        drop(lease);
        std::fs::remove_dir_all(&root).unwrap();
    });
}
