//! File-identity comparison and the exclusivity probe adoption needs.
//!
//! Identity (`dwVolumeSerialNumber`, `nFileIndexHigh`, `nFileIndexLow`) proves
//! an inherited handle *names* the canonical lock; it does not prove the
//! handle is held exclusively, because Windows offers no API to read a
//! handle's share mode back. The exclusivity probe closes that gap: a
//! `GENERIC_READ` open with full sharing fails with `ERROR_SHARING_VIOLATION`
//! if and only if some handle holds the file with `dwShareMode = 0`.

use std::path::Path;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_SHARING_VIOLATION, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK, GetFileInformationByHandle, GetFileType,
    OPEN_EXISTING,
};

pub(super) type FileIdentity = (u32, u32, u32);

pub(super) fn is_disk_file(handle: HANDLE) -> bool {
    unsafe { GetFileType(handle) == FILE_TYPE_DISK }
}

pub(super) fn file_identity(handle: HANDLE) -> std::io::Result<FileIdentity> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let ok = unsafe { GetFileInformationByHandle(handle, &mut info) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

/// Opens `path` with `GENERIC_READ` and full sharing and reports whether
/// that open was refused with `ERROR_SHARING_VIOLATION` - the signal that
/// some handle currently holds the file exclusively. Any other outcome
/// (success, or a different error) means adoption cannot trust the inherited
/// handle as exclusive.
pub(super) fn probes_as_exclusively_held(path: &Path) -> std::io::Result<bool> {
    let wide = to_wide(path);
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle != INVALID_HANDLE_VALUE {
        unsafe { CloseHandle(handle) };
        return Ok(false);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) {
        return Ok(true);
    }
    Err(error)
}

pub(super) fn to_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// `SetHandleInformation(HANDLE_FLAG_INHERIT)`, the primitive a guarded CLI
/// spawn opts a lease handle into per spawn and clears again so no fixture
/// or unrelated child can outlive the process holding the lock. Test-only:
/// no production call site exists yet in this crate's own process (the
/// PowerShell harness that eventually spawns `agent-desktop.exe` with the
/// lease made inheritable does so through its own native call, not through
/// this Rust surface), but the mechanism this primitive wraps is exactly
/// what that spawn wrapper needs, so it is proven here.
#[cfg(test)]
pub(super) fn set_inheritable(handle: HANDLE, on: bool) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT;
    use windows_sys::Win32::Foundation::SetHandleInformation;

    let flag = if on { HANDLE_FLAG_INHERIT } else { 0 };
    let ok = unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, flag) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn is_inheritable(handle: HANDLE) -> std::io::Result<bool> {
    use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};

    let mut flags: u32 = 0;
    let ok = unsafe { GetHandleInformation(handle, &mut flags) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(flags & HANDLE_FLAG_INHERIT != 0)
}
