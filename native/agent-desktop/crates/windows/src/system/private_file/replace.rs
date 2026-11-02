//! Atomic promotion of a written temp file over its destination.
//!
//! `ReplaceFileW`, never `MoveFileEx`, replaces an existing destination. The
//! measured matrix (42/42 definite, zero successes without share-delete) is
//! asymmetric: `MoveFileEx` over an open target fails with
//! `ERROR_ACCESS_DENIED` (5) at every share mode including `0x4`/`0x7`, while
//! `ReplaceFileW` over a target held with `FILE_SHARE_DELETE` succeeds and
//! the held handle keeps reading the old bytes. On the source side the
//! tolerances invert: `ReplaceFileW` fails with `ERROR_SHARING_VIOLATION`
//! (32) over an open source at every share mode, so the fully written and
//! synced temp handle must be closed before the call. Error 5 is the
//! expected destination-side failure signature for move-style ops and 32 the
//! signature for replace-style ops. `ReplaceFileW` cannot create a missing
//! destination; an absent destination means no reader holds it, so that
//! branch falls back to the `MoveFileExW`-backed `std::fs::rename`.
//!
//! Temp files live in a write-scoped lease directory inside the
//! destination's parent, which inherits the same profile ACL. Each atomic
//! write creates its own lease directory — named with the pid plus a
//! per-write nonce, so concurrent same-parent writes in one process never
//! collide — and holds its handle for the duration of the write with a share
//! mode that deliberately omits `FILE_SHARE_DELETE`. That held handle is the
//! live-writer guard: a sweep before each write probes lease directories
//! with `DELETE` access and reclaims only those no live writer holds. The
//! lease handle is dropped and the directory removed on every exit path, so
//! a long-lived process retains no directory handle that would defeat
//! same-process snapshot pruning. The narrowed share mode applies
//! exclusively to this internal lease handle — artifact opens keep Rust's
//! default wide `FILE_SHARE_READ|WRITE|DELETE` mask, because any hardened
//! open that narrows it re-introduces the measured sharing-failure cluster.
//! Temp names reuse core's hashed-nonce scheme so they stay unpredictable to
//! a same-privilege racer.

use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::hash::{BuildHasher, RandomState};
use std::io::ErrorKind;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_SHARING_VIOLATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, ReplaceFileW,
};

use super::{invalid_input, locality, owner, path};

const TEMP_LEASE_PREFIX: &str = ".agent-desktop-tmp-p";
const LEASE_CREATE_ATTEMPTS: usize = 32;
const TEMP_CREATE_ATTEMPTS: usize = 32;
const MEASURED_REPLACE_FLAGS: u32 = 0;

pub(super) struct TempDirLease {
    directory: PathBuf,
    liveness_handle: Option<File>,
}

impl TempDirLease {
    pub(super) fn directory(&self) -> &Path {
        &self.directory
    }
}

impl Drop for TempDirLease {
    fn drop(&mut self) {
        drop(self.liveness_handle.take());
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

pub(super) fn acquire_write_lease(parent: &Path) -> std::io::Result<TempDirLease> {
    sweep_stale_lease_directories(parent);
    for _ in 0..LEASE_CREATE_ATTEMPTS {
        let directory = parent.join(fresh_lease_name());
        match std::fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
        match open_verified_liveness_handle(&directory) {
            Ok(handle) => {
                return Ok(TempDirLease {
                    directory,
                    liveness_handle: Some(handle),
                });
            }
            Err(error) if lease_open_collision_is_retryable(&error) => {
                let _ = std::fs::remove_dir_all(&directory);
                continue;
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&directory);
                return Err(error);
            }
        }
    }
    Err(std::io::Error::new(
        ErrorKind::AlreadyExists,
        "could not allocate a private temp lease directory",
    ))
}

/// A concurrent same-parent writer racing the sweep can leave a just-created
/// lease directory swept, delete-pending, or held by the sweep's probe handle,
/// so the liveness open surfaces `NotFound`, `ERROR_ACCESS_DENIED` (5), or
/// `ERROR_SHARING_VIOLATION` (32). Those are transient collisions retried on a
/// fresh nonce. Keying the OS-error cases on `raw_os_error` keeps the
/// owner/locality/reparse refusals — `PermissionDenied` with no OS code —
/// fatal, never retried.
fn lease_open_collision_is_retryable(error: &std::io::Error) -> bool {
    if error.kind() == ErrorKind::NotFound {
        return true;
    }
    match error.raw_os_error() {
        Some(code) => code == ERROR_SHARING_VIOLATION as i32 || code == ERROR_ACCESS_DENIED as i32,
        None => false,
    }
}

fn open_verified_liveness_handle(directory: &Path) -> std::io::Result<File> {
    let handle = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(directory)?;
    path::require_verified_lease_directory(&handle)?;
    owner::require_owned_by_eligible_principal(&handle, "the private temp directory")?;
    locality::require_local_for_private_write(&handle, "the private temp directory")?;
    Ok(handle)
}

fn fresh_lease_name() -> String {
    let nonce = RandomState::new().hash_one(std::time::SystemTime::now());
    format!("{TEMP_LEASE_PREFIX}{}-{nonce:016x}", std::process::id())
}

fn sweep_stale_lease_directories(parent: &Path) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_text) = name.to_str() else {
            continue;
        };
        if !name_text.starts_with(TEMP_LEASE_PREFIX) {
            continue;
        }
        let candidate = entry.path();
        if stale_lease_is_reclaimable(&candidate) {
            let _ = std::fs::remove_dir_all(&candidate);
            let _ = std::fs::remove_file(&candidate);
        }
    }
}

fn stale_lease_is_reclaimable(candidate: &Path) -> bool {
    OpenOptions::new()
        .access_mode(DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(candidate)
        .is_ok()
}

pub(super) fn create_private_temp_file(
    lease: &TempDirLease,
    destination_name: &str,
) -> std::io::Result<(PathBuf, File)> {
    for _ in 0..TEMP_CREATE_ATTEMPTS {
        let temporary = lease
            .directory()
            .join(agent_desktop_core::temporary_file_name(OsStr::new(
                destination_name,
            )));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        ErrorKind::AlreadyExists,
        "could not allocate a private temporary file",
    ))
}

pub(super) fn promote_temp_to_destination(
    destination: &Path,
    temporary: &Path,
) -> std::io::Result<()> {
    match replace_file_call(destination, temporary) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => {
            std::fs::rename(temporary, destination)
        }
        Err(error) => Err(annotate_replace_failure(error)),
    }
}

pub(super) fn replace_file_call(destination: &Path, temporary: &Path) -> std::io::Result<()> {
    let destination_wide = to_wide_null(destination)?;
    let temporary_wide = to_wide_null(temporary)?;
    let succeeded = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            temporary_wide.as_ptr(),
            std::ptr::null(),
            MEASURED_REPLACE_FLAGS,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if succeeded != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn annotate_replace_failure(error: std::io::Error) -> std::io::Error {
    let raw_code = error.raw_os_error().unwrap_or_default() as u32;
    std::io::Error::new(
        error.kind(),
        format!(
            "atomic replace failed: {}: {error}",
            replace_style_failure_detail(raw_code)
        ),
    )
}

pub(super) fn replace_style_failure_detail(code: u32) -> &'static str {
    match code {
        ERROR_SHARING_VIOLATION => {
            "the destination is held open without FILE_SHARE_DELETE \
             (32 is the destination-side signature for replace-style ops)"
        }
        ERROR_ACCESS_DENIED => {
            "access was denied \
             (5 is the destination-side signature for move-style ops, \
             so from ReplaceFileW it is a genuine permission failure)"
        }
        _ => "the destination could not be replaced",
    }
}

pub(super) fn to_wide_null(path: &Path) -> std::io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(invalid_input("private file path contains an interior NUL"));
    }
    wide.push(0);
    Ok(wide)
}
