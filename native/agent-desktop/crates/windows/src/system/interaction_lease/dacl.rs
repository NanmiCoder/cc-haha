//! Authoring and reading back the lock directory's DACL: three
//! `ACCESS_ALLOWED_ACE`s for `SYSTEM`, `BUILTIN\Administrators` and the
//! token user, and nothing else. `SetSecurityInfo` is called with
//! `PROTECTED_DACL_SECURITY_INFORMATION` so the directory does not also
//! carry whatever inheritable ACEs its world-writable parent would
//! otherwise hand it.

use std::os::windows::io::AsRawHandle;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::Authorization::{SE_FILE_OBJECT, SetSecurityInfo};
use windows_sys::Win32::Security::{
    ACL, AddAccessAllowedAce, DACL_SECURITY_INFORMATION, GetAce, GetAclInformation, InitializeAcl,
    PROTECTED_DACL_SECURITY_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

use super::sid::SidBuffer;

const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACL_HEADER_LEN: usize = 8;
const ACE_FIXED_LEN: usize = 8;

/// Replaces the handle's DACL with exactly three allow-ACEs and protects it
/// against inherited ACEs from the parent, on fresh creation only - an
/// existing directory is validated, never rewritten, since repairing a
/// directory this process may not own is not a reliable operation on
/// Windows and a loud refusal is the safer failure.
pub(super) fn author_protected_three_principal_dacl(
    handle: &std::fs::File,
    system: &SidBuffer,
    administrators: &SidBuffer,
    token_user: &SidBuffer,
) -> std::io::Result<()> {
    let principals = [system, administrators, token_user];
    let acl_len = ACL_HEADER_LEN
        + principals
            .iter()
            .map(|sid| ACE_FIXED_LEN + sid_len(sid))
            .sum::<usize>();
    let mut storage = vec![0_u64; acl_len.div_ceil(size_of::<u64>())];
    let acl_ptr = storage.as_mut_ptr().cast::<ACL>();
    if unsafe {
        InitializeAcl(
            acl_ptr,
            acl_len as u32,
            windows_sys::Win32::Security::ACL_REVISION,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    for sid in principals {
        if unsafe {
            AddAccessAllowedAce(
                acl_ptr,
                windows_sys::Win32::Security::ACL_REVISION,
                FILE_ALL_ACCESS,
                sid.as_psid(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    let raw: HANDLE = handle.as_raw_handle();
    let status = unsafe {
        SetSecurityInfo(
            raw,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl_ptr,
            std::ptr::null_mut(),
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    Ok(())
}

fn sid_len(sid: &SidBuffer) -> usize {
    unsafe { windows_sys::Win32::Security::GetLengthSid(sid.as_psid()) as usize }
}

/// `true` only when every ACE on `acl` is an `ACCESS_ALLOWED_ACE` whose SID
/// matches one of the three accepted principals - any other ACE type
/// (deny, audit, a fourth principal) fails the read-back closed.
///
/// Both pointers are checked before they are read even though the Win32
/// contract already promises them: `acl` because this takes a raw pointer and
/// must hold on its own rather than on a caller that happens to check, and the
/// per-ACE pointer because `GetAce` reporting success is a claim about the
/// pointer rather than a proof of it. The read is the security check that
/// decides whether the lock directory is trustworthy, so it fails closed on a
/// pointer it cannot justify instead of dereferencing one.
///
/// The header is copied out as a fixed-size block rather than read field by
/// field through the foreign pointer, so the size of every read is stated at
/// the call site instead of being implied by the type being dereferenced.
pub(super) fn dacl_grants_only(acl: *const ACL, accepted: &[&SidBuffer]) -> std::io::Result<bool> {
    if acl.is_null() {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    let count = ace_count(acl)?;
    for index in 0..count {
        let mut ace_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        if unsafe { GetAce(acl, index, &mut ace_ptr) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if ace_ptr.is_null() {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
        }
        let mut header = [0_u8; ACE_FIXED_LEN];
        unsafe {
            std::ptr::copy_nonoverlapping(ace_ptr.cast::<u8>(), header.as_mut_ptr(), header.len());
        }
        let ace_type = header[0];
        if ace_type != ACCESS_ALLOWED_ACE_TYPE {
            return Ok(false);
        }
        let sid_ptr = unsafe { ace_ptr.cast::<u8>().add(ACE_FIXED_LEN) }.cast();
        let sid = SidBuffer::copied_from_valid(sid_ptr)?;
        if !accepted.iter().any(|candidate| candidate.matches(&sid)) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn ace_count(acl: *const ACL) -> std::io::Result<u32> {
    let mut info = windows_sys::Win32::Security::ACL_SIZE_INFORMATION::default();
    let ok = unsafe {
        GetAclInformation(
            acl,
            (&raw mut info).cast(),
            size_of::<windows_sys::Win32::Security::ACL_SIZE_INFORMATION>() as u32,
            windows_sys::Win32::Security::AclSizeInformation,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(info.AceCount)
}
