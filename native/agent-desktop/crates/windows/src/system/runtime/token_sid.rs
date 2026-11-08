//! Shared SID buffer and process-token SID reads.
//!
//! `private_file::owner` and `interaction_lease::sid` each need to copy a
//! `PSID` out of its owning call, build a well-known SID, and read a token's
//! owner or user - byte-identical mechanics in service of two deliberately
//! different policies (see each module's own doc comment for which SIDs it
//! treats as legitimate: `owner` accepts a token's whole owner-eligible set,
//! `sid` distinguishes `TokenOwner` from `TokenUser` directly). This module
//! is the one place the mechanics live; the policy stays where it is
//! decided.

use std::fs::File;
use std::io::ErrorKind;
use std::os::windows::io::AsRawHandle;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetSecurityInfo, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    CreateWellKnownSid, EqualSid, GetLengthSid, GetTokenInformation, IsValidSid,
    OWNER_SECURITY_INFORMATION, PSID, SECURITY_MAX_SID_SIZE, TOKEN_INFORMATION_CLASS, TOKEN_OWNER,
    TOKEN_QUERY, TOKEN_USER, TokenOwner, TokenUser, WELL_KNOWN_SID_TYPE,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const TOKEN_OWNER_SIZE: usize = 8;
const _: () = assert!(size_of::<TOKEN_OWNER>() == TOKEN_OWNER_SIZE);
const TOKEN_USER_SIZE: usize = 16;
const _: () = assert!(size_of::<TOKEN_USER>() == TOKEN_USER_SIZE);

#[derive(Clone)]
pub(crate) struct SidBuffer {
    storage: Vec<u64>,
}

impl SidBuffer {
    pub(crate) fn copied_from_valid(sid: PSID) -> std::io::Result<Self> {
        Self::copied_from_valid_with_limit(sid, SECURITY_MAX_SID_SIZE as usize)
    }

    pub(crate) fn copied_from_valid_with_limit(
        sid: PSID,
        maximum_length: usize,
    ) -> std::io::Result<Self> {
        if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "the reported SID is not valid",
            ));
        }
        let length = unsafe { GetLengthSid(sid) } as usize;
        if length == 0 || length > maximum_length || length > SECURITY_MAX_SID_SIZE as usize {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "the reported SID has an impossible length",
            ));
        }
        let mut storage = vec![0_u64; length.div_ceil(size_of::<u64>())];
        unsafe {
            std::ptr::copy_nonoverlapping(
                sid.cast::<u8>(),
                storage.as_mut_ptr().cast::<u8>(),
                length,
            );
        }
        Ok(Self { storage })
    }

    pub(crate) fn well_known(sid_type: WELL_KNOWN_SID_TYPE) -> std::io::Result<Self> {
        let mut storage = [0_u64; (SECURITY_MAX_SID_SIZE as usize).div_ceil(size_of::<u64>())];
        let mut size = std::mem::size_of_val(&storage) as u32;
        let created = unsafe {
            CreateWellKnownSid(
                sid_type,
                std::ptr::null_mut(),
                storage.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if created == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Self::copied_from_valid(storage.as_mut_ptr().cast())
    }

    pub(crate) fn as_psid(&self) -> PSID {
        self.storage.as_ptr().cast::<core::ffi::c_void>().cast_mut()
    }

    pub(crate) fn matches(&self, other: &SidBuffer) -> bool {
        unsafe { EqualSid(self.as_psid(), other.as_psid()) != 0 }
    }

    /// The textual `S-1-5-...` form, used as the per-user path segment under
    /// the lock root so two different token users never share a lock path.
    pub(crate) fn to_string_form(&self) -> std::io::Result<String> {
        let mut wide: windows_sys::core::PWSTR = std::ptr::null_mut();
        let converted = unsafe { ConvertSidToStringSidW(self.as_psid(), &mut wide) };
        if converted == 0 || wide.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let text = unsafe { pwstr_to_string(wide) };
        unsafe { LocalFree(wide.cast()) };
        Ok(text)
    }
}

unsafe fn pwstr_to_string(wide: windows_sys::core::PWSTR) -> String {
    let mut length = 0usize;
    unsafe {
        while *wide.add(length) != 0 {
            length += 1;
        }
    }
    let slice = unsafe { std::slice::from_raw_parts(wide, length) };
    String::from_utf16_lossy(slice)
}

/// Which token to read: this process's own, or one a caller already opened.
#[derive(Clone, Copy)]
pub(crate) enum TokenSource {
    CurrentProcess,
    Handle(HANDLE),
}

/// The user a token names, read through the same two-call probe every other
/// token read here uses.
///
/// The buffer is `u64`-backed rather than `u8`-backed on purpose. `TOKEN_USER`
/// holds a pointer, so reading one out of a byte vector is an unaligned read -
/// it happens to work while the allocator hands back aligned blocks and is
/// undefined the moment it does not. Anything in this crate that needs a
/// token's user calls this rather than repeating the sequence.
pub(crate) fn token_user_sid(token: TokenSource) -> std::io::Result<SidBuffer> {
    let buffer = match token {
        TokenSource::CurrentProcess => read_process_token_information(TokenUser)?,
        TokenSource::Handle(handle) => read_token_information(handle, TokenUser)?,
    };
    let user: TOKEN_USER = unsafe { std::ptr::read(buffer.as_ptr().cast()) };
    SidBuffer::copied_from_valid(user.User.Sid)
}

/// The owner a token names. See [`token_user_sid`] - same probe, `TokenOwner`
/// in place of `TokenUser`.
pub(crate) fn token_owner_sid(token: TokenSource) -> std::io::Result<SidBuffer> {
    let buffer = match token {
        TokenSource::CurrentProcess => read_process_token_information(TokenOwner)?,
        TokenSource::Handle(handle) => read_token_information(handle, TokenOwner)?,
    };
    let owner: TOKEN_OWNER = unsafe { std::ptr::read(buffer.as_ptr().cast()) };
    SidBuffer::copied_from_valid(owner.Owner)
}

/// The owner `GetSecurityInfo` reports for an already-open file or directory
/// handle - the read every owner-eligibility and lease-directory-ownership
/// check starts from.
pub(crate) fn read_owner_sid(file: &File) -> std::io::Result<SidBuffer> {
    let mut owner: PSID = std::ptr::null_mut();
    let mut descriptor: *mut core::ffi::c_void = std::ptr::null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    let copied = SidBuffer::copied_from_valid(owner);
    if !descriptor.is_null() {
        unsafe { LocalFree(descriptor) };
    }
    copied
}

pub(crate) fn read_process_token_information(
    class: TOKEN_INFORMATION_CLASS,
) -> std::io::Result<Vec<u64>> {
    let mut token: HANDLE = std::ptr::null_mut();
    let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    if opened == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let information = read_token_information(token, class);
    unsafe { CloseHandle(token) };
    information
}

fn read_token_information(
    token: HANDLE,
    class: TOKEN_INFORMATION_CLASS,
) -> std::io::Result<Vec<u64>> {
    let mut required: u32 = 0;
    let probed =
        unsafe { GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut required) };
    if probed != 0 || required == 0 {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "the process token reported no information payload",
        ));
    }
    let probe_error = std::io::Error::last_os_error();
    if probe_error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
        return Err(probe_error);
    }
    let mut buffer = vec![0_u64; (required as usize).div_ceil(size_of::<u64>())];
    let fetched = unsafe {
        GetTokenInformation(
            token,
            class,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    };
    if fetched == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(buffer)
}
