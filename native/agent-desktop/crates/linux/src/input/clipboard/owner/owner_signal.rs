use std::io;
use std::os::fd::OwnedFd;

use rustix::process::{Pid, PidfdFlags, Signal, pidfd_open, pidfd_send_signal};

use super::owner_record::{OwnerRecord, start_ticks_of};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stopped {
    Signalled,
    Stale,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenFailure {
    Gone,
    Unsupported,
}

pub(crate) trait ProcessControl {
    type Handle;
    fn open(&self, pid: u32) -> Result<Self::Handle, OpenFailure>;
    fn start_ticks(&self, pid: u32) -> Option<u64>;
    fn signal(&self, handle: &Self::Handle) -> io::Result<()>;
}

/// Ends the process a record names, and only that process. The handle is
/// opened first and the start time checked after it, so a pid that is
/// recycled between the check and the signal cannot be hit: the handle
/// names the process it was opened on. Without handle support nothing is
/// signalled.
pub(crate) fn stop_by_identity<C: ProcessControl>(control: &C, record: &OwnerRecord) -> Stopped {
    if record.pid == 0 {
        return Stopped::Stale;
    }
    let handle = match control.open(record.pid) {
        Ok(handle) => handle,
        Err(OpenFailure::Gone) => return Stopped::Stale,
        Err(OpenFailure::Unsupported) => return Stopped::Unsupported,
    };
    if control.start_ticks(record.pid) != Some(record.start_ticks) {
        return Stopped::Stale;
    }
    match control.signal(&handle) {
        Ok(()) => Stopped::Signalled,
        Err(_) => Stopped::Stale,
    }
}

pub(crate) struct PidfdControl;

impl ProcessControl for PidfdControl {
    type Handle = OwnedFd;

    fn open(&self, pid: u32) -> Result<OwnedFd, OpenFailure> {
        let pid = i32::try_from(pid)
            .ok()
            .and_then(Pid::from_raw)
            .ok_or(OpenFailure::Gone)?;
        pidfd_open(pid, PidfdFlags::empty()).map_err(|error| {
            if error == rustix::io::Errno::SRCH {
                OpenFailure::Gone
            } else {
                OpenFailure::Unsupported
            }
        })
    }

    fn start_ticks(&self, pid: u32) -> Option<u64> {
        start_ticks_of(pid)
    }

    fn signal(&self, handle: &OwnedFd) -> io::Result<()> {
        pidfd_send_signal(handle, Signal::TERM).map_err(io::Error::from)
    }
}

#[cfg(test)]
#[path = "owner_signal_tests.rs"]
mod tests;
