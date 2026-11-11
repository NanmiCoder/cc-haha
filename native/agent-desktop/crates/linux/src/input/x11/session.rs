use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::Arc;
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::thread;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, InteractionLease};

use super::held_journal::HeldJournal;
use super::progress::Progress;
use super::signal_release;
use super::sink::X11Sink;
use super::sink_error::SinkError;
use super::worker::{self, ABORT_SUGGESTION, Link, Report};
use super::worker_slot::{self, WorkerSlot};
use super::xtest_sink::XtestSink;
use crate::input::delivery::{Delivery, Gate};
use crate::input::keyboard::keymap::Keymap;
use crate::input::plan::Plan;
use crate::input::release_state::ReleaseState;

const WORKER_GRACE: Duration = Duration::from_millis(250);
const RELEASE_ALLOWANCE: Duration = Duration::from_secs(2);

pub(crate) struct CallEnv<'a> {
    pub(crate) deadline: Deadline,
    pub(crate) journal: Option<HeldJournal>,
    pub(crate) slot: Arc<WorkerSlot>,
    pub(crate) release_on_signal: bool,
    pub(crate) lease: Option<&'a InteractionLease>,
}

pub(crate) fn run(
    display: &str,
    plans: Vec<Plan>,
    gate: Gate<'_>,
    lease: &InteractionLease,
) -> Result<Delivery, AdapterError> {
    let deadline = lease.deadline();
    let display = display.to_owned();
    let journal = HeldJournal::in_runtime_dir(&display);
    let cutoff = deadline.remaining() + RELEASE_ALLOWANCE;
    run_journaled(
        move || XtestSink::connect(&display, deadline, cutoff),
        plans,
        gate,
        CallEnv {
            deadline,
            journal,
            slot: worker_slot::shared(),
            release_on_signal: true,
            lease: Some(lease),
        },
    )
}

pub(crate) fn live_keymap(display: &str, lease: &InteractionLease) -> Result<Keymap, AdapterError> {
    let deadline = lease.deadline();
    let display = display.to_owned();
    let journal = HeldJournal::in_runtime_dir(&display);
    let cutoff = deadline.remaining() + RELEASE_ALLOWANCE;
    read_keymap(
        move || XtestSink::connect(&display, deadline, cutoff),
        journal,
        worker_slot::shared(),
        deadline,
        Some(lease),
    )
}

fn read_keymap<S: X11Sink + 'static>(
    open: impl FnOnce() -> Result<S, AdapterError> + Send + 'static,
    journal: Option<HeldJournal>,
    slot: Arc<WorkerSlot>,
    deadline: Deadline,
    lease: Option<&InteractionLease>,
) -> Result<Keymap, AdapterError> {
    let claim = slot.claim(deadline)?;
    let lease = lease.map(retain_lease).transpose()?;
    let read = crate::system::x11::start(move || {
        let _claim = claim;
        let _lease = lease;
        let mut sink = open()?;
        if let Some(journal) = journal {
            journal.release_stale(&mut sink)?;
        }
        sink.keymap().map_err(SinkError::into_adapter)
    });
    read.finish(deadline)
        .unwrap_or_else(|| Err(worker::mark_started(deadline.timeout_error(), false)))
}

pub(crate) fn run_journaled<S: X11Sink + 'static>(
    open: impl FnOnce() -> Result<S, AdapterError> + Send + 'static,
    plans: Vec<Plan>,
    gate: Gate<'_>,
    env: CallEnv<'_>,
) -> Result<Delivery, AdapterError> {
    let CallEnv {
        deadline,
        journal,
        slot,
        release_on_signal,
        lease,
    } = env;
    let claim = slot.claim(deadline)?;
    let lease = lease.map(retain_lease).transpose()?;
    let progress = Arc::new(Progress::default());
    let _armed =
        release_on_signal.then(|| signal_release::arm(Arc::clone(&progress), Arc::clone(&slot)));
    let (reports, inbox) = channel();
    let (proceed_tx, proceed) = channel();
    let link = Link {
        reports,
        proceed,
        journal,
    };
    let worker_progress = Arc::clone(&progress);
    let spawned = thread::Builder::new()
        .name("x11-input".to_owned())
        .spawn(move || {
            let _claim = claim;
            let _lease = lease;
            match open() {
                Ok(sink) => worker::work(sink, plans, &link, deadline, &worker_progress),
                Err(error) => {
                    let _ = link.reports.send(Report::Done(Err(error)));
                }
            }
        });
    if spawned.is_err() {
        return Err(AdapterError::internal("The input worker could not start")
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()));
    }
    loop {
        match inbox.recv_timeout(deadline.remaining() + WORKER_GRACE) {
            Ok(Report::Gate) => match gate() {
                Ok(()) => {
                    let _ = proceed_tx.send(true);
                }
                Err(error) => {
                    let _ = proceed_tx.send(false);
                    progress.cancel();
                    return Err(interrupted(error, &progress, false));
                }
            },
            Ok(Report::Done(outcome)) => return outcome,
            Err(RecvTimeoutError::Timeout) => {
                progress.cancel();
                return Err(abandoned(deadline, &progress));
            }
            Err(RecvTimeoutError::Disconnected) => {
                progress.cancel();
                let lost = AdapterError::new(
                    ErrorCode::Internal,
                    "The input worker ended without an answer",
                );
                return Err(interrupted(lost, &progress, true));
            }
        }
    }
}

fn retain_lease(lease: &InteractionLease) -> Result<OwnedFd, AdapterError> {
    let fd = lease.duplicate_inheritable_fd()?;
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(AdapterError::internal(format!(
            "The input worker could not retain the interaction lease: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(fd)
}

fn abandoned(deadline: Deadline, progress: &Progress) -> AdapterError {
    interrupted(deadline.timeout_error(), progress, true)
}

fn interrupted(error: AdapterError, progress: &Progress, releasing: bool) -> AdapterError {
    let delivered = progress.delivered();
    let started = progress.has_started();
    let error = worker::mark_started(error, started);
    ReleaseState::resumed(delivered, releasing && started).enrich_error(error, ABORT_SUGGESTION)
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "session_lease_tests.rs"]
mod lease_tests;

#[cfg(test)]
#[path = "session_planning_tests.rs"]
mod planning_tests;

#[cfg(test)]
#[path = "session_cancel_tests.rs"]
mod cancel_tests;
