//! A ceiling on the flush threads a renderer may abandon.
//!
//! `FlushFileBuffers` on a pipe server returns only once the client has read
//! everything and it takes no timeout, so a client that never reads parks the
//! thread that called it for good. Running it on a thread that may be
//! abandoned is what keeps the renderer itself pumping; without a ceiling,
//! though, one control per abandoned thread accumulates for as long as the
//! renderer lives.
//!
//! The wait is best-effort already - it gives up at `ACKNOWLEDGEMENT_BUDGET`
//! and the client is prepared to time out - so declining to start one more is
//! the same outcome the caller already handles, and it is the outcome only
//! once the ceiling is reached. A healthy flush returns and gives its slot
//! back, so the ceiling is only ever met by clients that genuinely went away.

use std::sync::atomic::{AtomicUsize, Ordering};

const MAX_PARKED_FLUSHES: usize = 4;

static PARKED: AtomicUsize = AtomicUsize::new(0);

/// Holds one slot for as long as its flush thread runs. A flush that returns
/// drops this and frees the slot; one parked in Win32 never does, which is
/// the condition being bounded.
pub(crate) struct ParkedFlush(&'static AtomicUsize);

impl ParkedFlush {
    pub(crate) fn claim() -> Option<Self> {
        Self::claim_from(&PARKED, MAX_PARKED_FLUSHES)
    }

    /// The counter is a parameter so a test can exhaust a ceiling of its own
    /// rather than the process-wide one a live renderer shares.
    pub(crate) fn claim_from(counter: &'static AtomicUsize, ceiling: usize) -> Option<Self> {
        let taken = counter.fetch_add(1, Ordering::SeqCst);
        if taken >= ceiling {
            counter.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Self(counter))
    }
}

impl Drop for ParkedFlush {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
#[path = "parked_flush_tests.rs"]
mod tests;
