use std::path::{Path, PathBuf};

use agent_desktop_core::SystemOps;

use super::*;
use super::{directory, identity};
use crate::adapter::WindowsAdapter;
use crate::system::fixture::test_support::with_interaction_lease_test_lock;
use crate::system::interaction_lease::tests::scratch_root;

fn raw_open(path: &Path, share_mode: u32) -> HANDLE {
    let wide = identity::to_wide(path);
    unsafe {
        windows_sys::Win32::Storage::FileSystem::CreateFileW(
            wide.as_ptr(),
            windows_sys::Win32::Foundation::GENERIC_READ
                | windows_sys::Win32::Foundation::GENERIC_WRITE,
            share_mode,
            std::ptr::null(),
            windows_sys::Win32::Storage::FileSystem::OPEN_ALWAYS,
            windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    }
}

#[test]
fn adoption_of_share_zero_handle_succeeds_and_still_blocks_a_fresh_acquire() {
    with_interaction_lease_test_lock(|| {
        let root = scratch_root("adopt-success");
        let path = canonical_lock_path_at(&root).unwrap();
        directory::ensure_private(lock_directory(&path).unwrap()).unwrap();
        let raw = raw_open(&path, 0);
        assert_ne!(raw, windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE);

        let adopted = adopt_inherited_at(&root, raw as isize, Deadline::after(1_000).unwrap())
            .expect("adoption of an exclusively held canonical handle must succeed");
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(raw);
        }

        let error = match acquire_at(&root, Deadline::after(50).unwrap()) {
            Ok(_) => panic!("the adopted duplicate must still hold the lease exclusively"),
            Err(error) => error,
        };
        assert_eq!(error.code, ErrorCode::Timeout);

        drop(adopted);
        acquire_at(&root, Deadline::after(1_000).unwrap()).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    });
}

#[test]
fn adoption_of_an_unrelated_file_fails_policy_denied() {
    with_interaction_lease_test_lock(|| {
        let root = scratch_root("adopt-mismatch");
        let path = canonical_lock_path_at(&root).unwrap();
        directory::ensure_private(lock_directory(&path).unwrap()).unwrap();
        let unrelated_path = lock_directory(&path).unwrap().join("unrelated.lock");
        let raw = raw_open(&unrelated_path, 0);
        assert_ne!(raw, windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE);

        let error = match adopt_inherited_at(&root, raw as isize, Deadline::after(100).unwrap()) {
            Ok(_) => panic!("an unrelated file's handle must be refused"),
            Err(error) => error,
        };
        assert_eq!(error.code, ErrorCode::PolicyDenied);

        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(raw);
        }
        std::fs::remove_dir_all(&root).unwrap();
    });
}

/// **Invert-verified**: removing the exclusivity-probe block from
/// `adopt_inherited_impl` makes this exact test start passing adoption
/// (the identity check alone cannot tell a shared open from an exclusive
/// one).
#[test]
fn adoption_of_a_shared_handle_fails_lease_not_exclusive() {
    with_interaction_lease_test_lock(|| {
        let root = scratch_root("adopt-shared");
        let path = canonical_lock_path_at(&root).unwrap();
        directory::ensure_private(lock_directory(&path).unwrap()).unwrap();
        let raw = raw_open(
            &path,
            windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ
                | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE,
        );
        assert_ne!(raw, windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE);

        let error = match adopt_inherited_at(&root, raw as isize, Deadline::after(100).unwrap()) {
            Ok(_) => panic!("a non-exclusively-opened handle must be refused"),
            Err(error) => error,
        };
        assert_eq!(error.code, ErrorCode::PolicyDenied);
        assert_eq!(
            error.details.as_ref().unwrap()["kind"],
            "lease_not_exclusive"
        );

        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(raw);
        }
        std::fs::remove_dir_all(&root).unwrap();
    });
}

#[test]
fn adoption_of_a_non_disk_handle_fails() {
    with_interaction_lease_test_lock(|| {
        let root = scratch_root("adopt-non-disk");
        let console = console_handle_for_test();
        let error = match adopt_inherited_at(&root, console as isize, Deadline::after(100).unwrap())
        {
            Ok(_) => panic!("a console (non-disk) handle must be refused"),
            Err(error) => error,
        };
        assert_eq!(error.code, ErrorCode::PolicyDenied);
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(console);
        }
        std::fs::remove_dir_all(&root).unwrap();
    });
}

fn console_handle_for_test() -> HANDLE {
    let name: Vec<u16> = "CONOUT$\0".encode_utf16().collect();
    let handle = unsafe {
        windows_sys::Win32::Storage::FileSystem::CreateFileW(
            name.as_ptr(),
            windows_sys::Win32::Foundation::GENERIC_READ
                | windows_sys::Win32::Foundation::GENERIC_WRITE,
            windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ
                | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE,
            std::ptr::null(),
            windows_sys::Win32::Storage::FileSystem::OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(
        handle,
        windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE,
        "this test needs a console attached to open CONOUT$"
    );
    handle
}

#[test]
fn handle_is_not_inheritable_by_default_and_toggles_via_set_inheritable() {
    let root = scratch_root("inheritable");
    let path = canonical_lock_path_at(&root).unwrap();
    directory::ensure_private(lock_directory(&path).unwrap()).unwrap();
    let handle = raw_open(&path, 0);
    assert_ne!(handle, windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE);

    assert!(!identity::is_inheritable(handle).unwrap());
    identity::set_inheritable(handle, true).unwrap();
    assert!(identity::is_inheritable(handle).unwrap());
    identity::set_inheritable(handle, false).unwrap();
    assert!(!identity::is_inheritable(handle).unwrap());

    unsafe {
        windows_sys::Win32::Foundation::CloseHandle(handle);
    }
    std::fs::remove_dir_all(&root).unwrap();
}

/// Re-exec target for the env-independence test below: prints the resolved
/// path to stdout. Never touched by an ordinary `cargo test` run (guarded on
/// the marker env var), so it costs nothing outside that one test.
#[test]
fn report_canonical_lock_path_for_env_independence_check() {
    if std::env::var_os("AGENT_DESKTOP_WIN_REPORT_CANONICAL_LOCK_PATH").is_none() {
        return;
    }
    let path = canonical_lock_path().unwrap();
    println!("{}", path.display());
}

/// Isolates the five environment variables in a **child process** rather
/// than mutating `std::env` in this test binary: `cargo test` runs many
/// tests on parallel OS threads inside one process, and the environment is
/// process-global, so a `std::env::set_var` here raced an unrelated test
/// (`private_file::owner_tests`) that reads `LOCALAPPDATA` concurrently and
/// failed it - observed on this box before this test was rewritten to spawn
/// a child instead. **Invert-verified**: pointing the resolver at
/// `std::env::var("LOCALAPPDATA")` (or any of the other four) instead of
/// `GetSystemWindowsDirectoryW` makes this exact test fail, because the
/// child's reported path would then move with the scratch value its
/// environment carries.
#[test]
fn canonical_lock_path_is_unchanged_by_the_harnesss_isolated_environment() {
    with_interaction_lease_test_lock(|| {
        let before = canonical_lock_path().unwrap();
        let scratch = scratch_root("env-independence");
        let scratch_text = scratch.to_string_lossy().into_owned();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(
                "system::interaction_lease::adoption_tests::\
                 report_canonical_lock_path_for_env_independence_check",
            )
            .arg("--nocapture")
            .env("AGENT_DESKTOP_WIN_REPORT_CANONICAL_LOCK_PATH", "1")
            .env("TEMP", &scratch_text)
            .env("TMP", &scratch_text)
            .env("HOME", &scratch_text)
            .env("LOCALAPPDATA", &scratch_text)
            .env("APPDATA", &scratch_text)
            .output()
            .unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        let reported = stdout
            .lines()
            .find(|line| line.as_bytes().get(1) == Some(&b':'))
            .expect("child did not report a resolved path");
        assert_eq!(before, PathBuf::from(reported.trim()));
        std::fs::remove_dir_all(&scratch).unwrap();
    });
}

/// **Invert-verified**: routing the adapter's self-acquire branch at
/// `acquire_at(scratch_root, deadline)` instead of `acquire(deadline)` makes
/// this test fail - the real canonical path would then never be touched, so
/// the exclusivity probe against it would never observe contention.
#[test]
fn the_adapter_override_acquires_the_real_canonical_lock_not_a_scratch_root() {
    with_interaction_lease_test_lock(|| {
        let adapter = WindowsAdapter::new();
        let canonical = canonical_lock_path().unwrap();
        let held_before = identity::probes_as_exclusively_held(&canonical).unwrap_or(false);
        assert!(
            !held_before,
            "the canonical lock must be free before this test acquires it"
        );

        let lease = SystemOps::acquire_interaction_lease(&adapter, Deadline::after(2_000).unwrap())
            .expect("the adapter override must acquire successfully");
        assert!(
            identity::probes_as_exclusively_held(&canonical).unwrap(),
            "the exact path canonical_lock_path() resolves must now be held exclusively"
        );

        drop(lease);
        assert!(
            !identity::probes_as_exclusively_held(&canonical).unwrap(),
            "dropping the lease must release the real canonical lock"
        );
    });
}
