//! Storage locality classification for private-artifact write surfaces.
//!
//! `GetFileInformationByHandleEx(FileRemoteProtocolInfo)` (class 13) signals a
//! local volume by failing with `ERROR_INVALID_PARAMETER` (87): measured, zero
//! of six local targets returned data while three of three remote targets did.
//! The trap is that an out-of-range class returns the same 87, so 87 counts
//! as a locality signal only behind a control call — `FileBasicInfo` (class 0)
//! must first succeed on the same handle to prove the call plumbing.
//!
//! If the control call fails the verdict is `Unknown`, and `Unknown` is
//! refused for private-artifact writes: failing open would stream private
//! data to SMB storage on a redirected profile. Reads are never gated by
//! locality — the deleted v0.5.0 layer's locality check killed `status` on
//! ordinary local disk, which is why the control-call discipline exists and
//! why only write surfaces consult this module.

use std::fs::File;
use std::os::windows::io::AsRawHandle;

use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_BASIC_INFO, FILE_REMOTE_PROTOCOL_INFO, FileBasicInfo, FileRemoteProtocolInfo,
    GetFileInformationByHandleEx,
};

use super::permission_denied;

const FILE_BASIC_INFO_SIZE: usize = 40;
const _: () = assert!(size_of::<FILE_BASIC_INFO>() == FILE_BASIC_INFO_SIZE);

pub(super) const FILE_REMOTE_PROTOCOL_INFO_SIZE: usize = 116;
const _: () = assert!(size_of::<FILE_REMOTE_PROTOCOL_INFO>() == FILE_REMOTE_PROTOCOL_INFO_SIZE);

/// The kernel validates the output buffer's alignment before dispatching the
/// information class: a 4-aligned `FILE_REMOTE_PROTOCOL_INFO` fails with
/// `ERROR_NOACCESS` (998) instead of reaching the class handler that returns
/// the measured 87, so the probe buffer is forced to 8-byte alignment while
/// the byte count stays the measured 116.
#[repr(C, align(8))]
pub(super) struct AlignedRemoteProtocolInfo(pub(super) FILE_REMOTE_PROTOCOL_INFO);

const _: () = assert!(size_of::<AlignedRemoteProtocolInfo>() == 120);

impl AlignedRemoteProtocolInfo {
    pub(super) fn zeroed() -> Self {
        Self(FILE_REMOTE_PROTOCOL_INFO::default())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SurfaceLocality {
    Local,
    Remote,
    Unknown,
}

pub(super) fn require_local_for_private_write(file: &File, what: &str) -> std::io::Result<()> {
    match assess_file_locality(file) {
        SurfaceLocality::Local => Ok(()),
        SurfaceLocality::Remote => Err(permission_denied(format!(
            "{what} resides on remote storage; private artifacts must stay on local disk"
        ))),
        SurfaceLocality::Unknown => Err(permission_denied(format!(
            "{what} locality could not be determined; refusing to write private artifacts to it"
        ))),
    }
}

pub(super) fn assess_file_locality(file: &File) -> SurfaceLocality {
    let control_succeeded = basic_info_control_succeeds(control_probe_handle(file));
    let remote_probe = remote_protocol_probe_result(file);
    classify_surface_locality(control_succeeded, remote_probe)
}

fn remote_protocol_probe_result(file: &File) -> Result<(), u32> {
    #[cfg(test)]
    if forced_remote_locality::is_active() {
        return Ok(());
    }
    remote_protocol_probe(file.as_raw_handle())
}

pub(super) fn classify_surface_locality(
    control_succeeded: bool,
    remote_probe: Result<(), u32>,
) -> SurfaceLocality {
    match (control_succeeded, remote_probe) {
        (false, _) => SurfaceLocality::Unknown,
        (true, Ok(())) => SurfaceLocality::Remote,
        (true, Err(ERROR_INVALID_PARAMETER)) => SurfaceLocality::Local,
        (true, Err(_)) => SurfaceLocality::Unknown,
    }
}

pub(super) fn basic_info_control_succeeds(handle: HANDLE) -> bool {
    let mut information = FILE_BASIC_INFO::default();
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            std::ptr::from_mut(&mut information).cast(),
            FILE_BASIC_INFO_SIZE as u32,
        )
    };
    succeeded != 0
}

pub(super) fn remote_protocol_probe(handle: HANDLE) -> Result<(), u32> {
    let mut information = AlignedRemoteProtocolInfo::zeroed();
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileRemoteProtocolInfo,
            std::ptr::from_mut(&mut information).cast(),
            FILE_REMOTE_PROTOCOL_INFO_SIZE as u32,
        )
    };
    if succeeded != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or_default() as u32)
    }
}

fn control_probe_handle(file: &File) -> HANDLE {
    #[cfg(test)]
    if forced_control_failure::is_active() {
        return windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    }
    file.as_raw_handle()
}

#[cfg(test)]
pub(super) mod forced_control_failure {
    use std::cell::Cell;

    thread_local! {
        static FORCE_CONTROL_FAILURE: Cell<bool> = const { Cell::new(false) };
    }

    pub(in super::super) fn is_active() -> bool {
        FORCE_CONTROL_FAILURE.with(Cell::get)
    }

    pub(in super::super) fn with_forced_control_failure<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&FORCE_CONTROL_FAILURE, true, run)
    }
}

/// Forces the remote-protocol probe to report success while the class-0
/// control call still runs for real, so the classifier yields `Remote` and
/// the remote-storage refusal branch can be exercised on ordinary local disk.
#[cfg(test)]
pub(super) mod forced_remote_locality {
    use std::cell::Cell;

    thread_local! {
        static FORCE_REMOTE_LOCALITY: Cell<bool> = const { Cell::new(false) };
    }

    pub(in super::super) fn is_active() -> bool {
        FORCE_REMOTE_LOCALITY.with(Cell::get)
    }

    pub(in super::super) fn with_forced_remote_locality<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&FORCE_REMOTE_LOCALITY, true, run)
    }
}
