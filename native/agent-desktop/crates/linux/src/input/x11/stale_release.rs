use std::sync::Arc;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline};

use super::held_journal::HeldJournal;
use super::worker_slot::{self, WorkerSlot};
use super::xtest_sink::XtestSink;
use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::{
    interaction::interaction_lease,
    x11::{self, PendingRead},
};

const SWEEP_BUDGET_MS: u64 = 1_000;
const CUTOFF: Duration = Duration::from_millis(1_500);

/// Releases the keys and buttons a dead input call of this display left held.
/// A command that only reads the desktop calls it, so a killed drag does not
/// stay stuck until the next physical input. It connects only when a record
/// of a dead process exists.
pub(crate) fn sweep() {
    let DisplayServer::X11(display) = session_server() else {
        return;
    };
    let Some(journal) = HeldJournal::in_runtime_dir(&display) else {
        return;
    };
    if !journal.has_stale_entries() {
        return;
    }
    let Ok(deadline) = Deadline::detached_after(SWEEP_BUDGET_MS) else {
        return;
    };
    let Ok(pending) = start_sweep(deadline, worker_slot::shared(), move || {
        if let Ok(mut sink) = XtestSink::connect(&display, deadline, CUTOFF) {
            journal.release_readable_stale(&mut sink);
        }
    }) else {
        return;
    };
    let _ = pending.finish(deadline);
}

fn start_sweep(
    deadline: Deadline,
    slot: Arc<WorkerSlot>,
    sweep: impl FnOnce() + Send + 'static,
) -> Result<PendingRead<()>, AdapterError> {
    let lease = interaction_lease::acquire(deadline)?;
    let claim = slot.claim(deadline)?;
    Ok(x11::start(move || {
        let _lease = lease;
        let _claim = claim;
        sweep();
    }))
}

#[cfg(test)]
#[path = "stale_release_tests.rs"]
mod tests;
