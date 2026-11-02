use std::fs::File;
use std::os::windows::io::AsRawHandle;

use windows_sys::Win32::Foundation::{HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo,
};
use windows_sys::Win32::Security::{
    ACL, AddAccessAllowedAceEx, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, GetAce,
    GetAclInformation, InitializeAcl, OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION,
    WinBuiltinAdministratorsSid, WinLocalSystemSid,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

use super::owner;
use crate::system::runtime::token_sid::{self, SidBuffer, TokenSource};

const ACL_HEADER_LEN: usize = 8;
const ACE_FIXED_LEN: usize = 8;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

pub(super) fn protect_directory(handle: &File) -> std::io::Result<()> {
    protect(handle, CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE)
}

fn protect(handle: &File, inheritance: u32) -> std::io::Result<()> {
    let principals = principals()?;
    let acl_len = ACL_HEADER_LEN
        + principals
            .iter()
            .map(|sid| ACE_FIXED_LEN + sid_len(sid))
            .sum::<usize>();
    let mut storage = vec![0_u64; acl_len.div_ceil(size_of::<u64>())];
    let acl = storage.as_mut_ptr().cast::<ACL>();
    if unsafe {
        InitializeAcl(
            acl,
            acl_len as u32,
            windows_sys::Win32::Security::ACL_REVISION,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    for sid in &principals {
        if unsafe {
            AddAccessAllowedAceEx(
                acl,
                windows_sys::Win32::Security::ACL_REVISION,
                inheritance,
                FILE_ALL_ACCESS,
                sid.as_psid(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    let status = unsafe {
        SetSecurityInfo(
            handle.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null_mut(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(status as i32))
    }
}

pub(super) fn require_private(handle: &File) -> std::io::Result<()> {
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: *mut core::ffi::c_void = std::ptr::null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    let result = if dacl.is_null() {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "private file has no DACL",
        ))
    } else {
        principals().and_then(|accepted| grants_only(dacl, &accepted))
    };
    if !descriptor.is_null() {
        unsafe { LocalFree(descriptor) };
    }
    result
}

fn principals() -> std::io::Result<Vec<SidBuffer>> {
    let mut principals = vec![
        SidBuffer::well_known(WinLocalSystemSid)?,
        SidBuffer::well_known(WinBuiltinAdministratorsSid)?,
        token_sid::token_user_sid(TokenSource::CurrentProcess)?,
    ];
    principals.extend(owner::process_owner_eligible_sids()?.entries());
    Ok(principals)
}

fn grants_only(acl: *const ACL, accepted: &[SidBuffer]) -> std::io::Result<()> {
    let mut info = windows_sys::Win32::Security::ACL_SIZE_INFORMATION::default();
    if unsafe {
        GetAclInformation(
            acl,
            (&raw mut info).cast(),
            size_of_val(&info) as u32,
            windows_sys::Win32::Security::AclSizeInformation,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    for index in 0..info.AceCount {
        let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
        if unsafe { GetAce(acl, index, &mut ace) } == 0 || ace.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut header = [0_u8; ACE_FIXED_LEN];
        unsafe {
            std::ptr::copy_nonoverlapping(ace.cast::<u8>(), header.as_mut_ptr(), header.len())
        };
        let ace_size = u16::from_le_bytes([header[2], header[3]]) as usize;
        if header[0] != ACCESS_ALLOWED_ACE_TYPE || ace_size < ACE_FIXED_LEN + 8 {
            return Err(denied());
        }
        let sid = unsafe {
            SidBuffer::copied_from_valid_with_limit(
                ace.cast::<u8>().add(ACE_FIXED_LEN).cast(),
                ace_size - ACE_FIXED_LEN,
            )?
        };
        if !accepted.iter().any(|candidate| candidate.matches(&sid)) {
            return Err(denied());
        }
    }
    Ok(())
}

fn sid_len(sid: &SidBuffer) -> usize {
    unsafe { windows_sys::Win32::Security::GetLengthSid(sid.as_psid()) as usize }
}

fn denied() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "private file DACL grants an untrusted principal",
    )
}
