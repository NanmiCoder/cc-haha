//! The lock directory: resolving the canonical root without touching an
//! environment variable, creating it privately on first use, and refusing
//! (never repairing) anything that does not validate as private.
//!
//! Three independent checks port all three things
//! `ensure_unix_runtime_directory` / `validate_unix_runtime_directory` do
//! (`crates/core/src/session/interaction_lease.rs:163-203`) to a platform where
//! `mkdir` does not yield euid ownership: an owner check that accepts
//! either `TokenOwner` or `TokenUser` - the two shapes an elevated
//! administrator's own created directories actually carry on this platform -
//! a `GetFinalPathNameByHandle` comparison that catches a junction at any
//! level of the path rather than only a leaf reparse point, and a DACL
//! read-back that admits only `SYSTEM`, `BUILTIN\Administrators` and the
//! token user.

#[cfg(test)]
use std::cell::RefCell;
use std::fs::{File, OpenOptions};
use std::io::ErrorKind;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{ACL, DACL_SECURITY_INFORMATION};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_READ, GetFinalPathNameByHandleW,
};
use windows_sys::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;

use super::dacl;
use super::sid;
use crate::system::runtime::token_sid::read_owner_sid;
use agent_desktop_core::{AdapterError, ErrorCode};

const EXTENDED_LENGTH_PREFIX: &str = r"\\?\";

#[cfg(test)]
thread_local! {
    static CREATE_RACE: RefCell<Option<(PathBuf, PathBuf)>> = const { RefCell::new(None) };
}

/// `GetSystemWindowsDirectoryW`'s drive joined to `ProgramData\agent-desktop`.
/// Reads no environment variable, so an isolated `%TEMP%`/`%LOCALAPPDATA%`
/// cannot move it and two concurrent, differently-isolated invocations still
/// contend on the same lock.
///
/// `ProgramData` itself is canonicalized (it always exists, unlike
/// `ProgramData\agent-desktop` on a fresh box) so an ambient redirect above
/// it resolves once, here - `agent-desktop` and everything below it are then
/// literal joins that `validate_final_path` compares byte-for-byte, so a
/// reparse point planted at either the shared `agent-desktop` folder or the
/// per-user leaf is caught rather than silently followed.
pub(super) fn canonical_root() -> Result<PathBuf, AdapterError> {
    let windows_dir = system_windows_directory()?;
    let program_data = Path::new(&drive_root(&windows_dir)?).join("ProgramData");
    let canonical_program_data = std::fs::canonicalize(&program_data).map_err(io_untrusted)?;
    Ok(strip_extended_prefix(&canonical_program_data).join("agent-desktop"))
}

/// The drive root **with** its trailing separator (`"C:\"`), not just the
/// bare prefix component (`"C:"`) `Path::components()` yields. `Path::join`
/// treats a bare `"C:"` as drive-*relative* - `Path::new("C:").join("x")`
/// produces `"C:x"`, which Windows resolves against the current directory on
/// that drive rather than its root - so joining onto the prefix alone
/// silently detached the lock path from the drive root it was meant to name.
fn drive_root(windows_dir: &Path) -> Result<String, AdapterError> {
    let text = windows_dir.to_string_lossy();
    let end = text
        .find('\\')
        .map(|index| index + 1)
        .ok_or_else(|| untrusted("the system Windows directory has no root separator"))?;
    Ok(text[..end].to_string())
}

/// `std::fs::canonicalize` always returns the `\\?\`-prefixed extended-length
/// form on Windows; every path this module builds downstream is compared
/// against `GetFinalPathNameByHandleW`'s output after that same prefix is
/// stripped (see `validate_final_path`), so the prefix is stripped exactly
/// once, here, rather than re-derived at each comparison site.
pub(super) fn strip_extended_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    PathBuf::from(text.strip_prefix(EXTENDED_LENGTH_PREFIX).unwrap_or(&text))
}

fn system_windows_directory() -> Result<PathBuf, AdapterError> {
    let buffer = grow_and_retry_wide_buffer("GetSystemWindowsDirectoryW", true, |buffer| unsafe {
        GetSystemWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32)
    })?;
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer)))
}

/// One Win32 `GetXxxW`-shaped probe-then-grow: called once against a 300-`u16`
/// guess, and - when it reports a longer length than that - once more against
/// a buffer sized to fit. `strict_retry_check` is the one place the two
/// existing callers already disagreed: `GetSystemWindowsDirectoryW`'s caller
/// also re-checked the retry itself still fit (guarding a length that grew
/// again between the two calls), `GetFinalPathNameByHandleW`'s did not: each
/// keeps its own answer here rather than the merge silently picking one.
fn grow_and_retry_wide_buffer(
    context: &str,
    strict_retry_check: bool,
    call: impl Fn(&mut [u16]) -> u32,
) -> Result<Vec<u16>, AdapterError> {
    let mut buffer = vec![0_u16; 300];
    let written = call(&mut buffer);
    if written == 0 {
        return Err(win32_error(&format!("{context} failed")));
    }
    if written as usize >= buffer.len() {
        buffer = vec![0_u16; written as usize + 1];
        let retried = call(&mut buffer);
        if retried == 0 || (strict_retry_check && retried as usize >= buffer.len()) {
            return Err(win32_error(&format!("{context} failed on retry")));
        }
        buffer.truncate(retried as usize);
    } else {
        buffer.truncate(written as usize);
    }
    Ok(buffer)
}

/// Creates `directory` privately if absent, or validates it if present.
/// Never repairs a directory that fails validation: a `chmod`-equivalent on
/// a directory this process may not own is not reliably available on
/// Windows, so a loud refusal in a world-writable root is the safer failure.
pub(super) fn ensure_private(directory: &Path) -> Result<(), AdapterError> {
    let freshly_created = create_if_absent(directory)?;
    let handle = open_backup_semantics(directory)?;
    validate_is_directory(&handle)?;
    validate_final_path(&handle, directory)?;
    validate_owner(&handle)?;
    if freshly_created {
        let system = sid::well_known_system_sid().map_err(io_untrusted)?;
        let administrators = sid::well_known_administrators_sid().map_err(io_untrusted)?;
        let token_user = sid::process_token_user_sid().map_err(io_untrusted)?;
        dacl::author_protected_three_principal_dacl(&handle, system, administrators, token_user)
            .map_err(io_untrusted)?;
    }
    validate(&handle, directory)
}

/// Creates the whole chain down to `directory` - on a fresh box the shared
/// `ProgramData\agent-desktop` parent does not exist yet either, so a
/// single-level `create_dir` would fail `NotFound`. Only `directory` itself
/// (never an ordinary intermediate such as `agent-desktop`) is treated as
/// "freshly created" for DACL-authoring purposes; existence is checked
/// before creating rather than read off `create_dir_all`'s result, which
/// does not distinguish "created" from "already there".
fn create_if_absent(directory: &Path) -> Result<bool, AdapterError> {
    let parent = directory
        .parent()
        .ok_or_else(|| untrusted("lock directory path has no parent"))?;
    std::fs::create_dir_all(parent).map_err(io_untrusted)?;
    #[cfg(test)]
    inject_create_race(directory);
    match std::fs::create_dir(directory) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(io_untrusted(error)),
    }
}

#[cfg(test)]
pub(super) fn with_create_race<R>(directory: &Path, target: &Path, run: impl FnOnce() -> R) -> R {
    CREATE_RACE.with(|race| {
        let previous = race.replace(Some((directory.to_owned(), target.to_owned())));
        let result = run();
        race.replace(previous);
        result
    })
}

#[cfg(test)]
fn inject_create_race(directory: &Path) {
    let target = CREATE_RACE.with(|race| {
        let matches = race
            .borrow()
            .as_ref()
            .is_some_and(|(expected, _)| expected == directory);
        matches
            .then(|| race.borrow_mut().take().map(|(_, target)| target))
            .flatten()
    });
    if let Some(target) = target {
        crate::system::private_file::tests::create_junction(directory, &target);
    }
}

fn open_backup_semantics(directory: &Path) -> Result<File, AdapterError> {
    OpenOptions::new()
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .access_mode(
            FILE_GENERIC_READ
                | windows_sys::Win32::Storage::FileSystem::READ_CONTROL
                | windows_sys::Win32::Storage::FileSystem::WRITE_DAC,
        )
        .open(directory)
        .map_err(io_untrusted)
}

fn validate(handle: &File, directory: &Path) -> Result<(), AdapterError> {
    validate_is_directory(handle)?;
    validate_final_path(handle, directory)?;
    validate_owner(handle)?;
    validate_dacl(handle)?;
    Ok(())
}

fn validate_is_directory(handle: &File) -> Result<(), AdapterError> {
    let metadata = handle.metadata().map_err(io_untrusted)?;
    if !metadata.is_dir() {
        return Err(untrusted("lock directory path is not a directory"));
    }
    Ok(())
}

/// `expected` is deliberately compared as-is, never re-canonicalized here:
/// it is already built from a canonical root (`canonical_root()` resolves
/// `ProgramData` once, before any of this module's own path segments are
/// joined onto it; test scratch roots do the equivalent). Canonicalizing
/// `expected` again inside this function would transparently follow a
/// hostile reparse point planted at the leaf itself, which is exactly the
/// attack this comparison exists to catch.
fn validate_final_path(handle: &File, expected: &Path) -> Result<(), AdapterError> {
    let raw: HANDLE = handle.as_raw_handle();
    let buffer = grow_and_retry_wide_buffer("GetFinalPathNameByHandleW", false, |buffer| unsafe {
        GetFinalPathNameByHandleW(raw, buffer.as_mut_ptr(), buffer.len() as u32, 0)
    })?;
    let actual = String::from_utf16_lossy(&buffer);
    let actual = actual
        .strip_prefix(EXTENDED_LENGTH_PREFIX)
        .unwrap_or(&actual);
    let expected_text = expected.to_string_lossy();
    let expected_text = expected_text
        .strip_prefix(EXTENDED_LENGTH_PREFIX)
        .unwrap_or(&expected_text);
    if !actual.eq_ignore_ascii_case(expected_text) {
        return Err(untrusted(
            "lock directory resolves through a reparse point somewhere on its path",
        ));
    }
    Ok(())
}

fn validate_owner(handle: &File) -> Result<(), AdapterError> {
    let owner = read_owner_sid(handle).map_err(io_untrusted)?;
    let token_owner = sid::process_token_owner_sid().map_err(io_untrusted)?;
    let token_user = sid::process_token_user_sid().map_err(io_untrusted)?;
    if owner.matches(token_owner) || owner.matches(token_user) {
        return Ok(());
    }
    Err(untrusted(
        "lock directory owner is neither this process's token owner nor its token user",
    ))
}

fn validate_dacl(handle: &File) -> Result<(), AdapterError> {
    let mut dacl_ptr: *mut ACL = std::ptr::null_mut();
    let mut descriptor: *mut core::ffi::c_void = std::ptr::null_mut();
    let raw: HANDLE = handle.as_raw_handle();
    let status = unsafe {
        GetSecurityInfo(
            raw,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl_ptr,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(win32_error("GetSecurityInfo(DACL) failed"));
    }
    let result = (|| -> Result<(), AdapterError> {
        if dacl_ptr.is_null() {
            return Err(untrusted("lock directory has no DACL at all"));
        }
        let system = sid::well_known_system_sid().map_err(io_untrusted)?;
        let administrators = sid::well_known_administrators_sid().map_err(io_untrusted)?;
        let token_user = sid::process_token_user_sid().map_err(io_untrusted)?;
        let accepted = [system, administrators, token_user];
        let ok = dacl::dacl_grants_only(dacl_ptr, &accepted).map_err(io_untrusted)?;
        if !ok {
            return Err(untrusted(
                "lock directory DACL grants a principal outside {SYSTEM, BUILTIN\\Administrators, token user}",
            ));
        }
        Ok(())
    })();
    if !descriptor.is_null() {
        unsafe { windows_sys::Win32::Foundation::LocalFree(descriptor) };
    }
    result
}

fn untrusted(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::Internal, message).with_details(serde_json::json!({
        "kind": "lease_directory_untrusted",
    }))
}

fn io_untrusted(error: std::io::Error) -> AdapterError {
    untrusted(&format!("lock directory is not trustworthy: {error}"))
}

fn win32_error(message: &str) -> AdapterError {
    io_untrusted(std::io::Error::last_os_error()).with_platform_detail(message)
}
