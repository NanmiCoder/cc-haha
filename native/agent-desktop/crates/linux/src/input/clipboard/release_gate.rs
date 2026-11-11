use std::sync::atomic::{AtomicU8, Ordering};

use super::x11_read::Fault;

const PENDING: u8 = 0;
const COMMITTED: u8 = 1;
const CANCELLED: u8 = 2;

/// Decides between a worker that releases the selection on its own thread and
/// the caller that stops waiting for it. Whichever moves the gate first wins:
/// a worker that finds the gate cancelled sends nothing, and a caller that
/// finds it committed knows the release may already be on the wire.
#[derive(Debug, Default)]
pub(crate) struct ReleaseGate(AtomicU8);

impl ReleaseGate {
    pub(crate) fn commit(&self) -> bool {
        self.0
            .compare_exchange(PENDING, COMMITTED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn cancel(&self) -> bool {
        self.0
            .compare_exchange(PENDING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// A failure that happened before the worker committed stays what it was.
    /// A failure after it says only that the release may have been sent.
    pub(crate) fn settle(&self, outcome: Result<(), Fault>) -> Result<(), Fault> {
        match outcome {
            Ok(()) => Ok(()),
            Err(fault) if self.cancel() => Err(fault),
            Err(_) => Err(Fault::MutationUnconfirmed),
        }
    }
}

#[cfg(test)]
#[path = "release_gate_tests.rs"]
mod tests;
