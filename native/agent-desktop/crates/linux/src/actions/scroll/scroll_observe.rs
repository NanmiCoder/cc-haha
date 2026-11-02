use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline};

/// Time as a watch on a scroll sees it. The real one sleeps; a test advances
/// a counter, so a judgement at 0.6 s against one at 1.3 s costs no waiting.
pub(crate) trait Waiter {
    fn elapsed(&self) -> Duration;
    fn pause(&mut self, span: Duration);
    /// What is left of the lease the whole call must finish inside.
    fn remaining(&self) -> Duration;
}

pub(crate) struct Clock {
    began: Instant,
    deadline: Deadline,
}

impl Clock {
    pub(crate) fn new(deadline: Deadline) -> Self {
        Self {
            began: Instant::now(),
            deadline,
        }
    }
}

impl Waiter for Clock {
    fn elapsed(&self) -> Duration {
        self.began.elapsed()
    }

    fn pause(&mut self, span: Duration) {
        std::thread::sleep(span.min(self.deadline.remaining()));
    }

    fn remaining(&self) -> Duration {
        self.deadline.remaining()
    }
}

/// Looks at the target until it reads on screen or `window` passes, whichever
/// comes first, and never past the lease. The first look is immediate. `true`
/// only on an observation of `Some(false)`; what a scroll call returned is
/// never consulted.
pub(crate) fn realised<W: Waiter>(
    waiter: &mut W,
    window: Duration,
    interval: Duration,
    mut look: impl FnMut() -> Result<Option<bool>, AdapterError>,
) -> Result<bool, AdapterError> {
    let began = waiter.elapsed();
    loop {
        if look()? == Some(false) {
            return Ok(true);
        }
        let spent = waiter.elapsed().saturating_sub(began);
        let left = window.saturating_sub(spent).min(waiter.remaining());
        if left.is_zero() {
            return Ok(false);
        }
        waiter.pause(interval.min(left));
    }
}

#[cfg(test)]
#[path = "scroll_observe_tests.rs"]
mod tests;
