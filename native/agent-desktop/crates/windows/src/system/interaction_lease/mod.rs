//! The Windows cross-process desktop-interaction lease.
//!
//! An exclusive `CreateFileW` open of a canonical, token-derived lock file
//! gives Windows the exclusivity property macOS gets from `flock`. An
//! inherited handle is adoptable only after two independent checks both
//! pass: a **file-identity** comparison against the canonical path, and an
//! **exclusivity probe**, because a handle's share mode cannot be read back
//! on Windows and identity alone proves naming rather than exclusion.
//!
//! Split into submodules because the lock implementation plus its identity
//! and DACL verification does not fit `system/adapter.rs`'s remaining
//! headroom under the 400-line cap, the same reasoning that already forced
//! `system/private_file` into a directory: `sid` (token/well-known SID
//! reads), `directory` (private lock-directory creation and validation),
//! `dacl` (DACL authoring and read-back), `identity` (file-identity
//! comparison and the exclusivity probe).

mod dacl;
mod directory;
mod identity;
mod sid;

use std::path::{Path, PathBuf};

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, InteractionLease, ProcessLeaseGuard};
use windows_sys::Win32::Foundation::{
    CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_ACCESS_DENIED,
    ERROR_SHARING_VIOLATION, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_ALWAYS, OPEN_EXISTING,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

/// Read by the adapter override to choose adoption over self-acquire.
/// Deliberately distinct from a live e2e harness's own process-handoff
/// variable: this one is the product's own protocol, so no non-agent child
/// ever inherits it by accident, and the harness's own handoff stays
/// independently testable from the product's adoption path.
pub(crate) const INTERACTION_LEASE_HANDLE_ENV: &str = "AGENT_DESKTOP_INTERACTION_LEASE_HANDLE";

const LOCK_FILE_NAME: &str = "interaction.lock";
const LEASE_PURPOSE: &str = "desktop interaction lease";

pub(crate) fn acquire(deadline: Deadline) -> Result<InteractionLease, AdapterError> {
    acquire_impl(&directory::canonical_root()?, deadline)
}

pub(crate) fn adopt_inherited(
    raw_handle: isize,
    deadline: Deadline,
) -> Result<InteractionLease, AdapterError> {
    adopt_inherited_impl(&directory::canonical_root()?, raw_handle, deadline)
}

/// The path a production acquisition resolves to. Pure path computation -
/// no directory creation, no validation - so a test proving the environment
/// cannot move it needs nothing more than a live process token. Test-only:
/// the environment-independence check and the adapter-resolves-the-real-path
/// check use it as an independent oracle for the path `acquire` and
/// `adopt_inherited` resolve.
#[cfg(test)]
pub(crate) fn canonical_lock_path() -> Result<PathBuf, AdapterError> {
    lock_path_under(&directory::canonical_root()?)
}

#[cfg(test)]
pub(crate) fn canonical_lock_path_at(root: &Path) -> Result<PathBuf, AdapterError> {
    lock_path_under(root)
}

/// Test-only seam mirroring core's `acquire_unix_interaction_lease_at`: the
/// only way this module's own contention/adoption/directory tests can run
/// without contending for the real machine-global lock. `acquire` and
/// `adopt_inherited` above are the only production callers of the resolver,
/// and neither takes a root parameter, so no environment or test hook can
/// redirect them.
#[cfg(test)]
pub(crate) fn acquire_at(
    root: &Path,
    deadline: Deadline,
) -> Result<InteractionLease, AdapterError> {
    acquire_impl(root, deadline)
}

#[cfg(test)]
pub(crate) fn adopt_inherited_at(
    root: &Path,
    raw_handle: isize,
    deadline: Deadline,
) -> Result<InteractionLease, AdapterError> {
    adopt_inherited_impl(root, raw_handle, deadline)
}

fn lock_path_under(root: &Path) -> Result<PathBuf, AdapterError> {
    let token_user = sid::process_token_user_sid().map_err(win32_internal_from)?;
    let sid_text = token_user.to_string_form().map_err(win32_internal_from)?;
    Ok(root.join(sid_text).join(LOCK_FILE_NAME))
}

fn acquire_impl(root: &Path, deadline: Deadline) -> Result<InteractionLease, AdapterError> {
    let process_guard = ProcessLeaseGuard::acquire(deadline)?;
    let process_contention = process_guard.contention_count();
    let path = lock_path_under(root)?;
    let directory = lock_directory(&path)?;
    directory::ensure_private(directory)?;
    let (handle, file_contention) = acquire_file_handle(&path, deadline)?;
    let contention = file_contention.saturating_add(process_contention);
    let guard = WindowsLeaseGuard {
        handle,
        _process: process_guard,
    };
    Ok(InteractionLease::guarded_with_contention(
        deadline, guard, contention,
    ))
}

fn adopt_inherited_impl(
    root: &Path,
    raw_handle: isize,
    deadline: Deadline,
) -> Result<InteractionLease, AdapterError> {
    let process_guard = ProcessLeaseGuard::acquire(deadline)?;
    let path = lock_path_under(root)?;
    directory::ensure_private(lock_directory(&path)?)?;
    let inherited: HANDLE = raw_handle as HANDLE;
    if !identity::is_disk_file(inherited) {
        return Err(policy_denied(
            None,
            "Inherited interaction lease handle is not a disk file",
        ));
    }
    let inherited_identity = identity::file_identity(inherited).map_err(|error| {
        policy_denied(
            None,
            &format!("could not read inherited interaction lease identity: {error}"),
        )
    })?;
    let canonical_identity = read_attribute_only_identity(&path)?;
    if inherited_identity != canonical_identity {
        return Err(policy_denied(
            None,
            "Inherited interaction lease does not identify the canonical lock file",
        ));
    }
    if !identity::probes_as_exclusively_held(&path).map_err(win32_internal_from)? {
        return Err(policy_denied(
            Some("lease_not_exclusive"),
            "Inherited interaction lease is not held exclusively",
        ));
    }
    let duplicated = duplicate_private(inherited)?;
    let contention = process_guard.contention_count();
    let guard = WindowsLeaseGuard {
        handle: duplicated,
        _process: process_guard,
    };
    Ok(InteractionLease::guarded_with_contention(
        deadline, guard, contention,
    ))
}

fn lock_directory(lock_path: &Path) -> Result<&Path, AdapterError> {
    lock_path
        .parent()
        .ok_or_else(|| AdapterError::internal("interaction lease path has no parent directory"))
}

fn acquire_file_handle(
    path: &Path,
    deadline: Deadline,
) -> Result<(OwnedLockHandle, u64), AdapterError> {
    let wide = identity::to_wide(path);
    let mut contention = 0_u64;
    loop {
        if deadline.is_expired() {
            return Err(lock_timeout(deadline, path, contention));
        }
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            if deadline.is_expired() {
                unsafe { CloseHandle(handle) };
                return Err(lock_timeout(deadline, path, contention));
            }
            return Ok((OwnedLockHandle(handle), contention));
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error().map(|code| code as u32) {
            Some(ERROR_SHARING_VIOLATION) => {
                contention = contention.saturating_add(1);
                let remaining = deadline.remaining();
                if remaining.is_zero() {
                    return Err(lock_timeout(deadline, path, contention));
                }
                std::thread::sleep(remaining.min(std::time::Duration::from_millis(10)));
            }
            Some(ERROR_ACCESS_DENIED) => {
                let rid = sid::process_token_integrity_rid().ok();
                return Err(integrity_denied(rid));
            }
            _ => {
                return Err(AdapterError::internal(format!(
                    "CreateFileW failed acquiring the interaction lease: {error}"
                )));
            }
        }
    }
}

fn read_attribute_only_identity(path: &Path) -> Result<identity::FileIdentity, AdapterError> {
    let wide = identity::to_wide(path);
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(policy_denied(
            None,
            &format!(
                "could not open the canonical lock path for identity comparison: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    let result = identity::file_identity(handle);
    unsafe { CloseHandle(handle) };
    result.map_err(|error| {
        policy_denied(
            None,
            &format!("could not read the canonical lock path's identity: {error}"),
        )
    })
}

fn duplicate_private(source: HANDLE) -> Result<OwnedLockHandle, AdapterError> {
    let mut target: HANDLE = std::ptr::null_mut();
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            source,
            GetCurrentProcess(),
            &mut target,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if ok == 0 {
        return Err(win32_internal(
            "DuplicateHandle failed adopting the interaction lease",
        ));
    }
    Ok(OwnedLockHandle(target))
}

struct OwnedLockHandle(HANDLE);

unsafe impl Send for OwnedLockHandle {}
unsafe impl Sync for OwnedLockHandle {}

impl Drop for OwnedLockHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Owns both halves of what this process holds: the open lock handle and
/// the in-process double-acquire guard. Neither field is read again once
/// constructed - both exist purely for the release their `Drop` performs
/// when core's `InteractionLease` drops this guard.
struct WindowsLeaseGuard {
    #[allow(dead_code)]
    handle: OwnedLockHandle,
    #[allow(dead_code)]
    _process: ProcessLeaseGuard,
}

fn lock_timeout(deadline: Deadline, path: &Path, contention_count: u64) -> AdapterError {
    deadline.timeout_error().with_details(serde_json::json!({
        "kind": "lock_timeout",
        "purpose": LEASE_PURPOSE,
        "path": path.display().to_string(),
        "contention_count": contention_count,
    }))
}

fn policy_denied(kind: Option<&str>, message: &str) -> AdapterError {
    let error = AdapterError::new(ErrorCode::PolicyDenied, message);
    match kind {
        Some(kind) => error.with_details(serde_json::json!({ "kind": kind })),
        None => error,
    }
}

fn integrity_denied(rid: Option<u32>) -> AdapterError {
    let mut details = serde_json::json!({ "kind": "lease_integrity_denied" });
    if let Some(rid) = rid {
        details["integrity_rid"] = serde_json::json!(rid);
    }
    AdapterError::new(
        ErrorCode::PermDenied,
        "Interaction lease acquisition was denied by mandatory integrity policy",
    )
    .with_details(details)
}

fn win32_internal(message: &str) -> AdapterError {
    AdapterError::internal(format!("{message}: {}", std::io::Error::last_os_error()))
}

fn win32_internal_from(error: std::io::Error) -> AdapterError {
    AdapterError::internal(error.to_string())
}

#[cfg(test)]
#[path = "tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
#[path = "adoption_tests.rs"]
mod adoption_tests;

#[cfg(test)]
#[path = "directory_tests.rs"]
mod directory_tests;
