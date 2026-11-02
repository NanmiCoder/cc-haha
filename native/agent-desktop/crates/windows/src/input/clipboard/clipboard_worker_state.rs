//! Whether a clipboard read this process started is still inside a Win32 call.
//!
//! A read that services a delay-rendered format blocks inside
//! `GetClipboardData` for as long as the owning application takes. When the
//! caller's deadline expires, the caller is told the read timed out — but the
//! worker is still parked in the OS call, so its session's `Drop` cannot run
//! and this process holds the clipboard open for the rest of the render. A
//! thread blocked in a Win32 call cannot be cancelled, so the answer is not to
//! stop it: it is to refuse the next clipboard operation instead of letting it
//! contend with a worker nothing can reclaim, and to say so.
//!
//! The reach of that refusal is exactly one process. An abandoned worker dies with the process that spawned it and Windows
//! releases the clipboard on exit, so a retry from a fresh invocation neither
//! needs this guard nor is affected by it. What it governs is a second
//! clipboard operation inside one invocation — a batch entry, or a command
//! that reads twice.

use std::sync::atomic::{AtomicUsize, Ordering};

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

static OUTSTANDING: AtomicUsize = AtomicUsize::new(0);

/// Held by a clipboard worker for as long as it is running. A worker that
/// returns — normally or by unwinding — drops its ticket; one parked inside a
/// Win32 call never does, which is precisely the condition being detected.
///
/// The counter is a parameter rather than a hard-coded global so a test can
/// arm one of its own. Arming the process-wide counter from a test would
/// refuse the live clipboard tests running beside it, which is a race the
/// guard would have caused rather than caught.
pub(crate) struct WorkerTicket(&'static AtomicUsize);

impl WorkerTicket {
    pub(crate) fn arm() -> Self {
        Self::arm_on(&OUTSTANDING)
    }

    pub(crate) fn arm_on(counter: &'static AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for WorkerTicket {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(crate) fn outstanding() -> usize {
    OUTSTANDING.load(Ordering::SeqCst)
}

/// The refusal a given outstanding count implies, separated from where the
/// count is read so it can be exercised without touching process-wide state.
pub(crate) fn refusal_for(outstanding: usize) -> Option<AdapterError> {
    if outstanding == 0 {
        return None;
    }
    Some(
        AdapterError::new(
            ErrorCode::AppUnresponsive,
            "A previous clipboard read is still inside GetClipboardData and holds the clipboard open",
        )
        .with_suggestion(
            "Wait for the previous read's owner to answer, or retry from a new invocation - an \
             abandoned read ends with the process that started it",
        )
        .with_platform_detail(format!(
            "{outstanding} clipboard worker(s) outstanding in this process"
        ))
        .with_disposition(DeliverySemantics::not_delivered()),
    )
}

/// Refuses when a previous read's worker is still holding the clipboard open.
///
/// `ensure_owner_responsive` answers a different question — whether the owning
/// application is dispatching messages at all — and a responsive-but-slow
/// renderer passes it, which is how the outstanding worker came to exist.
pub(crate) fn ensure_no_outstanding_worker() -> Result<(), AdapterError> {
    match refusal_for(outstanding()) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
#[path = "clipboard_worker_state_tests.rs"]
mod tests;
