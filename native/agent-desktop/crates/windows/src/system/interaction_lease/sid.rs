//! SID reads and comparisons the lease's directory validation needs:
//! this process's token owner, token user, and mandatory integrity RID, plus
//! the well-known `SYSTEM` and `BUILTIN\Administrators` SIDs the private
//! lock directory's DACL is authored for.
//!
//! Deliberately separate from `system/private_file/owner.rs`: that module
//! accepts a token's full owner-eligible SID set (`TokenUser`, `TokenOwner`,
//! and any `SE_GROUP_OWNER`-flagged token group) for its narrower purpose
//! (detecting a path pre-created by a foreign principal), while the lease
//! directory here only ever needs to distinguish `TokenOwner` from
//! `TokenUser` directly - an elevated administrator's own token routinely
//! carries a `TokenOwner` of `BUILTIN\Administrators` distinct from its
//! `TokenUser`, and a directory this process creates is owned by whichever
//! one Windows defaults new objects to.

use std::io::ErrorKind;
use std::sync::OnceLock;

#[cfg(test)]
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, TOKEN_MANDATORY_LABEL, TokenIntegrityLevel,
    WinBuiltinAdministratorsSid, WinLocalSystemSid,
};
#[cfg(test)]
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::system::runtime::token_sid::{TokenSource, token_owner_sid, token_user_sid};

pub(super) use crate::system::runtime::token_sid::SidBuffer;

/// Process-invariant like the token SIDs below, so it is cached the same
/// way: every lease acquisition (`directory::ensure_private`'s
/// `validate_dacl` read-back runs on every acquisition, not only on first
/// creation) otherwise rebuilds this well-known SID from scratch on the hot
/// path every action command takes.
pub(super) fn well_known_system_sid() -> std::io::Result<&'static SidBuffer> {
    static CACHE: OnceLock<Result<SidBuffer, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| SidBuffer::well_known(WinLocalSystemSid).map_err(|error| error.to_string()))
        .as_ref()
        .map_err(|message| std::io::Error::new(ErrorKind::PermissionDenied, message.clone()))
}

/// See [`well_known_system_sid`] - same process-invariant reasoning, same
/// cache shape.
pub(super) fn well_known_administrators_sid() -> std::io::Result<&'static SidBuffer> {
    static CACHE: OnceLock<Result<SidBuffer, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            SidBuffer::well_known(WinBuiltinAdministratorsSid).map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|message| std::io::Error::new(ErrorKind::PermissionDenied, message.clone()))
}

pub(super) fn process_token_owner_sid() -> std::io::Result<&'static SidBuffer> {
    static CACHE: OnceLock<Result<SidBuffer, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            token_owner_sid(TokenSource::CurrentProcess).map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|message| std::io::Error::new(ErrorKind::PermissionDenied, message.clone()))
}

pub(super) fn process_token_user_sid() -> std::io::Result<&'static SidBuffer> {
    static CACHE: OnceLock<Result<SidBuffer, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            token_user_sid(TokenSource::CurrentProcess).map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|message| std::io::Error::new(ErrorKind::PermissionDenied, message.clone()))
}

/// The caller's mandatory integrity RID (e.g. `0x2000` Medium, `0x1000` Low),
/// read from the last sub-authority of `TokenIntegrityLevel`'s label SID -
/// used only to annotate a `lease_integrity_denied` refusal, never to decide
/// policy.
pub(super) fn process_token_integrity_rid() -> std::io::Result<u32> {
    let buffer =
        crate::system::runtime::token_sid::read_process_token_information(TokenIntegrityLevel)?;
    let label: TOKEN_MANDATORY_LABEL = unsafe { std::ptr::read(buffer.as_ptr().cast()) };
    let sid = label.Label.Sid;
    let count = unsafe { *GetSidSubAuthorityCount(sid) };
    if count == 0 {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "the integrity label SID has no sub-authorities",
        ));
    }
    let rid = unsafe { *GetSidSubAuthority(sid, u32::from(count) - 1) };
    Ok(rid)
}

/// A raw process token handle wrapper used by test-only privilege
/// manipulation (`AdjustTokenPrivileges`), which needs `TOKEN_ADJUST_PRIVILEGES`
/// rather than the `TOKEN_QUERY` this module otherwise opens with.
#[cfg(test)]
pub(super) fn open_process_token_for_adjust() -> std::io::Result<HANDLE> {
    use windows_sys::Win32::Security::TOKEN_ADJUST_PRIVILEGES;

    let mut token: HANDLE = std::ptr::null_mut();
    let opened =
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES, &mut token) };
    if opened == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(token)
}
