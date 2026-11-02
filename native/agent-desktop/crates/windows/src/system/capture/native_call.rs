//! Bounded workers for Win32 calls that cannot be interrupted by a deadline.

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, sync_channel};
use std::thread;

static CAPTURE_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Whether no window capture holds the process-wide single-flight slot.
#[cfg(test)]
pub(crate) fn capture_is_idle() -> bool {
    !CAPTURE_ACTIVE.load(Ordering::Acquire)
}

pub(crate) fn capture<T: Send + 'static>(
    deadline: Deadline,
    label: &'static str,
    call: impl FnOnce() -> Result<T, AdapterError> + Send + 'static,
) -> Result<T, AdapterError> {
    run(
        deadline,
        &CAPTURE_ACTIVE,
        label,
        DeliverySemantics::not_delivered(),
        call,
    )
}

fn run<T: Send + 'static>(
    deadline: Deadline,
    active: &'static AtomicBool,
    label: &'static str,
    timeout_delivery: DeliverySemantics,
    call: impl FnOnce() -> Result<T, AdapterError> + Send + 'static,
) -> Result<T, AdapterError> {
    deadline.ensure_remaining()?;
    if active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            format!("A previous {label} call is still running"),
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    let (sender, receiver) = sync_channel(1);
    let worker = thread::Builder::new().name(format!("agent-desktop-{label}"));
    let spawn = worker.spawn(move || {
        let _ticket = ActiveTicket(active);
        let result = call();
        let _ = sender.send(result);
    });
    if let Err(error) = spawn {
        active.store(false, Ordering::Release);
        return Err(
            AdapterError::internal(format!("Could not start {label} worker: {error}"))
                .with_disposition(DeliverySemantics::not_delivered()),
        );
    }
    match receiver.recv_timeout(deadline.remaining()) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(deadline
            .timeout_error()
            .with_platform_detail(format!(
                "{label} remains in flight; its worker retains owned resources"
            ))
            .with_disposition(timeout_delivery)),
        Err(RecvTimeoutError::Disconnected) => Err(AdapterError::internal(format!(
            "{label} worker disconnected before returning"
        ))
        .with_disposition(timeout_delivery)),
    }
}

struct ActiveTicket(&'static AtomicBool);

impl Drop for ActiveTicket {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(test)]
#[path = "native_call_tests.rs"]
mod tests;
