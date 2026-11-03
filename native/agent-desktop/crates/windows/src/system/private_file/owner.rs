//! Ownership validation against the set of SIDs Windows itself would permit
//! this process's token to hold as a file owner.
//!
//! New filesystem objects land owned by `TokenOwner`, not `TokenUser`:
//! measured at both High and Medium integrity, a file created by an
//! admin-group account is owned by the Administrators group while
//! `OwnerMatchesTokenUser` is false and `OwnerMatchesTokenOwner` is true —
//! group membership is the variable, never integrity.
//!
//! `TokenOwner` is not itself stable for one human across elevation: measured
//! on the same account, a non-elevated process's `TokenOwner` reads as the
//! user SID, while an elevated process's reads as `BUILTIN\Administrators`,
//! because UAC elevation swaps the token's default owner to whichever group
//! carries the `SE_GROUP_OWNER` attribute. A validation that compared only
//! against `TokenOwner` therefore refused a path the same human created at a
//! different elevation — indistinguishable, by that check, from a foreign
//! principal. Validation instead accepts the owner-eligible set: `TokenUser`,
//! `TokenOwner`, and every `TokenGroups` entry whose attributes carry
//! `SE_GROUP_OWNER`. That is exactly the set of SIDs `SetSecurityInfo` would
//! let this token assign as an owner — no wider, no narrower.
//!
//! The purpose is narrow: detecting a path pre-created by a foreign
//! principal, the Windows analogue of the unix uid post-condition in core's
//! `private_file.rs`. It is explicitly not an isolation boundary between
//! administrator processes — an administrator holds
//! `SeTakeOwnershipPrivilege`, so no file-permission mechanism can exclude
//! one. The unix `nlink` post-condition has no measured Windows analogue and
//! is deliberately not carried here.
//!
//! Only the owner is read — `GetSecurityInfo` with
//! `OWNER_SECURITY_INFORMATION` and no DACL requested — so this module reads
//! a fixed-layout SID and never touches an ACE.

use std::fs::File;
use std::io::ErrorKind;
use std::sync::OnceLock;

use windows_sys::Win32::Security::{SID_AND_ATTRIBUTES, TOKEN_GROUPS, TokenGroups};

use super::permission_denied;
use crate::system::runtime::token_sid::{
    SidBuffer, TokenSource, read_process_token_information, token_owner_sid, token_user_sid,
};

/// `SE_GROUP_OWNER` from `Win32_System_SystemServices`, defined locally so
/// this module does not need that feature only for one flag constant. The
/// value is fixed by the Win32 ABI. A too-wide filter (accepting groups that
/// do not carry this flag) is pinned by
/// `owner_eligible_sids_contains_token_user_and_owner_but_excludes_everyone`,
/// which asserts `Everyone` stays out of the set even though it is present
/// in every token's groups.
const SE_GROUP_OWNER: u32 = 0x0000_0008;

/// The set of SIDs this process's token could legitimately have produced as
/// a file owner: its `TokenUser`, its `TokenOwner`, and every `TokenGroups`
/// entry carrying `SE_GROUP_OWNER`. Deliberately not "every group the token
/// belongs to" — a token holds many groups (`Everyone`, `Users`, ...) that
/// Windows never allows as an owner, and accepting those would make the
/// foreign-principal check meaningless.
pub(super) struct OwnerEligibleSids {
    entries: Vec<SidBuffer>,
}

impl OwnerEligibleSids {
    pub(super) fn contains(&self, candidate: &SidBuffer) -> bool {
        self.entries.iter().any(|sid| sid.matches(candidate))
    }

    pub(super) fn entries(&self) -> Vec<SidBuffer> {
        self.entries.clone()
    }
}

pub(super) fn require_owned_by_eligible_principal(file: &File, what: &str) -> std::io::Result<()> {
    let eligible = process_owner_eligible_sids()?;
    let actual = actual_owner_for_comparison(file)?;
    require_owner_in_set(&actual, eligible, what)
}

pub(super) fn require_actual_owner_by_eligible_principal(
    file: &File,
    what: &str,
) -> std::io::Result<()> {
    let eligible = process_owner_eligible_sids()?;
    let actual = file_owner_sid(file)?;
    require_owner_in_set(&actual, eligible, what)
}

fn require_owner_in_set(
    actual: &SidBuffer,
    eligible: &OwnerEligibleSids,
    what: &str,
) -> std::io::Result<()> {
    if !eligible.contains(actual) {
        return Err(permission_denied(format!(
            "{what} is owned by a foreign principal, not this process's token user, token \
             owner, or an owner-eligible token group; if a different principal owns this path \
             intentionally, relocate the state root with AGENT_DESKTOP_HOME instead of reusing it"
        )));
    }
    Ok(())
}

pub(super) fn process_owner_eligible_sids() -> std::io::Result<&'static OwnerEligibleSids> {
    static OWNER_ELIGIBLE_SIDS: OnceLock<Result<OwnerEligibleSids, String>> = OnceLock::new();
    OWNER_ELIGIBLE_SIDS
        .get_or_init(|| read_owner_eligible_sids().map_err(|error| error.to_string()))
        .as_ref()
        .map_err(|message| std::io::Error::new(ErrorKind::PermissionDenied, message.clone()))
}

fn read_owner_eligible_sids() -> std::io::Result<OwnerEligibleSids> {
    let mut entries = vec![
        read_process_token_user()?,
        token_owner_sid(TokenSource::CurrentProcess)?,
    ];
    entries.extend(read_owner_flagged_group_sids()?);
    Ok(OwnerEligibleSids { entries })
}

fn read_owner_flagged_group_sids() -> std::io::Result<Vec<SidBuffer>> {
    let buffer = read_process_token_information(TokenGroups)?;
    let byte_len = buffer.len() * size_of::<u64>();
    let bytes = buffer.as_ptr().cast::<u8>();
    if byte_len < size_of::<u32>() {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "the process token reported a truncated TokenGroups payload",
        ));
    }
    let group_count = unsafe { std::ptr::read_unaligned(bytes.cast::<u32>()) } as usize;
    let groups_offset = core::mem::offset_of!(TOKEN_GROUPS, Groups);
    let entry_size = size_of::<SID_AND_ATTRIBUTES>();
    let required_bytes = groups_offset
        .checked_add(group_count.saturating_mul(entry_size))
        .ok_or_else(|| {
            std::io::Error::new(
                ErrorKind::InvalidData,
                "the process token reported an impossible TokenGroups count",
            )
        })?;
    if required_bytes > byte_len {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "the process token reported more groups than its payload holds",
        ));
    }
    let mut owner_flagged = Vec::new();
    for index in 0..group_count {
        let entry_ptr = unsafe { bytes.add(groups_offset + index * entry_size) };
        let entry: SID_AND_ATTRIBUTES = unsafe { std::ptr::read_unaligned(entry_ptr.cast()) };
        if entry.Attributes & SE_GROUP_OWNER != 0 {
            owner_flagged.push(SidBuffer::copied_from_valid(entry.Sid)?);
        }
    }
    Ok(owner_flagged)
}

fn actual_owner_for_comparison(file: &File) -> std::io::Result<SidBuffer> {
    #[cfg(test)]
    if forced_foreign_owner::is_active() {
        return forced_foreign_owner::foreign_sid();
    }
    file_owner_sid(file)
}

pub(super) fn file_owner_sid(file: &File) -> std::io::Result<SidBuffer> {
    crate::system::runtime::token_sid::read_owner_sid(file)
}

#[cfg(test)]
pub(super) fn process_token_owner_sid() -> std::io::Result<&'static SidBuffer> {
    static PROCESS_TOKEN_OWNER: OnceLock<Result<SidBuffer, String>> = OnceLock::new();
    PROCESS_TOKEN_OWNER
        .get_or_init(|| {
            token_owner_sid(TokenSource::CurrentProcess).map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|message| std::io::Error::new(ErrorKind::PermissionDenied, message.clone()))
}

fn read_process_token_user() -> std::io::Result<SidBuffer> {
    token_user_sid(TokenSource::CurrentProcess)
}

#[cfg(test)]
pub(super) fn process_token_user_sid_for_tests() -> std::io::Result<SidBuffer> {
    read_process_token_user()
}

/// Forces the owner comparison to observe a foreign principal so the
/// refusal branch of `require_owned_by_eligible_principal` can be exercised without
/// a file actually pre-created by another account. The substituted owner is
/// the `WinLocalSystemSid`, built programmatically so the seam stays portable
/// and privilege-free.
#[cfg(test)]
pub(super) mod forced_foreign_owner {
    use std::cell::Cell;

    use windows_sys::Win32::Security::WinLocalSystemSid;

    use super::SidBuffer;

    thread_local! {
        static FORCE_FOREIGN_OWNER: Cell<bool> = const { Cell::new(false) };
    }

    pub(in super::super) fn is_active() -> bool {
        FORCE_FOREIGN_OWNER.with(Cell::get)
    }

    pub(in super::super) fn foreign_sid() -> std::io::Result<SidBuffer> {
        SidBuffer::well_known(WinLocalSystemSid)
    }

    pub(in super::super) fn with_forced_foreign_owner<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&FORCE_FOREIGN_OWNER, true, run)
    }
}
