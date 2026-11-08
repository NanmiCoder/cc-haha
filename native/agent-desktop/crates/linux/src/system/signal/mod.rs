use crate::system::signal::signal_sent::Sent;
use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use rustix::process::{Pid, PidfdFlags, Signal as KernelSignal, pidfd_open, pidfd_send_signal};

use crate::system::process::identity::Identity;
use crate::system::process::liveness;
use crate::system::process::process_facts;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Signal {
    Term,
    Kill,
}

impl Signal {
    fn name(self) -> &'static str {
        match self {
            Self::Term => "SIGTERM",
            Self::Kill => "SIGKILL",
        }
    }
}

/// The three kernel operations a signal needs, so the order of the token
/// reads around the descriptor can be tested without signalling anything.
pub(super) trait Kernel {
    type Handle;

    fn identity(&self, pid: u32, instance: &str) -> Identity;
    fn open(&self, pid: u32) -> Result<Self::Handle, i32>;
    fn deliver(&self, handle: &Self::Handle, signal: Signal) -> Result<(), i32>;
}

struct Live;

impl Kernel for Live {
    type Handle = rustix::fd::OwnedFd;

    fn identity(&self, pid: u32, instance: &str) -> Identity {
        liveness::identity(pid, instance)
    }

    fn open(&self, pid: u32) -> Result<Self::Handle, i32> {
        let raw = i32::try_from(pid).map_err(|_| process_facts::ESRCH)?;
        let pid = Pid::from_raw(raw).ok_or(process_facts::ESRCH)?;
        pidfd_open(pid, PidfdFlags::empty()).map_err(|errno| errno.raw_os_error())
    }

    fn deliver(&self, handle: &Self::Handle, signal: Signal) -> Result<(), i32> {
        let kernel = match signal {
            Signal::Term => KernelSignal::TERM,
            Signal::Kill => KernelSignal::KILL,
        };
        pidfd_send_signal(handle, kernel).map_err(|errno| errno.raw_os_error())
    }
}

fn refused(pid: u32, signal: Signal, errno: i32) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!("{} could not be sent to process {pid}", signal.name()),
    )
    .with_platform_detail(format!(
        "errno {errno}: {}",
        std::io::Error::from_raw_os_error(errno)
    ))
    .with_suggestion("The process belongs to another user or a sandbox refuses the signal.")
    .with_disposition(DeliverySemantics::not_delivered())
}

fn unreadable(pid: u32) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!("The identity of process {pid} could not be read, so no signal was sent"),
    )
    .with_disposition(DeliverySemantics::not_delivered())
}

fn settled(identity: Identity, pid: u32) -> Result<Option<Sent>, AdapterError> {
    match identity {
        Identity::Same => Ok(None),
        Identity::Gone => Ok(Some(Sent::AlreadyGone)),
        Identity::Replaced => Ok(Some(Sent::Replaced)),
        Identity::Unreadable => Err(unreadable(pid)),
    }
}

/// Sends `signal` to the process the caller saw. The token is read before
/// the descriptor is opened and again after: a process id recycled in
/// between is caught by the second read, and the descriptor then names the
/// process the token vouched for, so the signal can never reach another one.
pub(super) fn send_through(
    kernel: &impl Kernel,
    pid: u32,
    instance: &str,
    signal: Signal,
) -> Result<Sent, AdapterError> {
    if let Some(sent) = settled(kernel.identity(pid, instance), pid)? {
        return Ok(sent);
    }
    let handle = match kernel.open(pid) {
        Ok(handle) => handle,
        Err(process_facts::ESRCH) => return Ok(Sent::AlreadyGone),
        Err(errno) => return Err(refused(pid, signal, errno)),
    };
    if let Some(sent) = settled(kernel.identity(pid, instance), pid)? {
        return Ok(sent);
    }
    match kernel.deliver(&handle, signal) {
        Ok(()) => Ok(Sent::Delivered),
        Err(process_facts::ESRCH) => Ok(Sent::AlreadyGone),
        Err(errno) => Err(refused(pid, signal, errno)),
    }
}

pub(crate) fn send(pid: u32, instance: &str, signal: Signal) -> Result<Sent, AdapterError> {
    send_through(&Live, pid, instance, signal)
}

#[cfg(test)]
#[path = "signal_tests.rs"]
mod tests;

pub(super) mod signal_boundary;
pub(super) mod signal_capture;
pub(super) mod signal_inventory;
#[cfg(test)]
pub(super) mod signal_live_apps;
#[cfg(test)]
pub(super) mod signal_live_surfaces_tests;
#[cfg(test)]
pub(super) mod signal_live_tests;
pub(crate) mod signal_sent;
pub(super) mod signal_surfaces;
pub(crate) mod subscription;
mod wake_state;
