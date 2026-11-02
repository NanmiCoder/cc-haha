//! The clock a frame loop runs on, and when it is allowed to stop early.
//!
//! Both the travel and the click flourish sample a clock rather than counting
//! frames, so a dropped frame changes smoothness and never the instant the
//! cursor lands. Holding the interval and the start instant together keeps
//! that one decision in one place rather than once per loop.
//!
//! Stopping early is offered only to a loop that runs after its control has
//! been answered. A travel is what an action waits on before it dispatches,
//! so it plays to its end however much is queued behind it.

use super::schedule;
use std::time::{Duration, Instant};

/// Whether a frame loop should play on, or give way to something newer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Continuation {
    Play,
    Stop,
}

pub(crate) struct Frames {
    interval: Duration,
    started: Instant,
}

impl Frames {
    pub(crate) fn at(refresh_hz: u32) -> Self {
        Self {
            interval: schedule::frame_interval(refresh_hz),
            started: Instant::now(),
        }
    }

    pub(crate) fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    pub(crate) fn wait(&self) {
        std::thread::sleep(self.interval);
    }

    /// Waits out one interval unless a newer control is already waiting to be
    /// served, in which case the caller stops instead of sleeping.
    ///
    /// Asked before the sleep rather than after it, because the whole point is
    /// that a superseding control does not spend a frame waiting for a
    /// flourish nobody is looking at any more.
    pub(crate) fn wait_unless(&self, interrupt: &dyn Fn() -> bool) -> Continuation {
        if interrupt() {
            return Continuation::Stop;
        }
        self.wait();
        Continuation::Play
    }
}

#[cfg(test)]
#[path = "animation_tests.rs"]
mod tests;
