use std::time::Duration;

use agent_desktop_core::{AdapterError, DeliverySemantics};

use super::world::World;
use super::{Request, refusal};
use crate::system::close::close_plan::grace_within;
use crate::system::process::liveness::Liveness;
use crate::system::signal::Signal;
use crate::system::signal::signal_sent::Sent;

struct Progress {
    term_at: Option<Duration>,
    grace: Duration,
    killed: bool,
}

impl Progress {
    fn sent_anything(&self) -> bool {
        self.term_at.is_some() || self.killed
    }
}

fn deliver(world: &impl World, signal: Signal, progress: &Progress) -> Result<Sent, AdapterError> {
    world.signal(signal).map_err(|error| {
        if progress.sent_anything() {
            error.with_disposition(DeliverySemantics::delivered_unverified())
        } else {
            error
        }
    })
}

fn expired(world: &impl World, request: &Request<'_>, progress: &Progress) -> AdapterError {
    let timeout = world.timeout_error();
    if progress.sent_anything() {
        refusal::waited_out(timeout, request, None)
    } else {
        timeout.with_disposition(DeliverySemantics::not_delivered())
    }
}

/// The close that signals: `SIGTERM`, a bounded grace, then `SIGKILL`; a
/// stopped process gets `SIGKILL` alone. `Ok` only once the process is
/// observed gone, and a process that is gone or replaced by another is the
/// benign outcome, never a signal to the stranger.
pub(super) fn close(world: &impl World, request: &Request<'_>) -> Result<bool, AdapterError> {
    let mut progress = Progress {
        term_at: None,
        grace: Duration::ZERO,
        killed: false,
    };
    loop {
        let signal = match world.liveness() {
            Liveness::Gone => return Ok(progress.sent_anything()),
            Liveness::Stopped if !progress.killed => Some(Signal::Kill),
            Liveness::Alive if progress.term_at.is_none() => Some(Signal::Term),
            Liveness::Alive if !progress.killed => {
                let since_term = progress
                    .term_at
                    .map(|at| world.elapsed().saturating_sub(at))
                    .unwrap_or_default();
                (since_term >= progress.grace).then_some(Signal::Kill)
            }
            Liveness::Alive | Liveness::Stopped => None,
        };
        if let Some(signal) = signal {
            if world.remaining().is_zero() && !progress.sent_anything() {
                return Err(expired(world, request, &progress));
            }
            match deliver(world, signal, &progress)? {
                Sent::Delivered => match signal {
                    Signal::Term => {
                        progress.term_at = Some(world.elapsed());
                        progress.grace = grace_within(world.remaining());
                    }
                    Signal::Kill => progress.killed = true,
                },
                Sent::AlreadyGone | Sent::Replaced => return Ok(progress.sent_anything()),
            }
        }
        if world.remaining().is_zero() {
            return Err(expired(world, request, &progress));
        }
        world.pause();
    }
}

#[cfg(test)]
#[path = "force_tests.rs"]
mod tests;
