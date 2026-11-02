//! How long the resolution retry loop waits between attempts.
//!
//! A fixed pause spends the whole budget at one rate. A provider that is
//! briefly busy is caught by the opening polls either way, but one that is
//! genuinely struggling gets asked forty times a second for as long as the
//! deadline allows - load added to the thing already failing. Doubling keeps
//! the fast case fast and lets the hopeless case cost little, and the ceiling
//! keeps a long deadline from stretching one pause past usefulness.

use agent_desktop_core::Deadline;
use std::time::Duration;

pub(crate) const FIRST_RETRY_PAUSE: Duration = Duration::from_millis(25);
pub(crate) const MAXIMUM_RETRY_PAUSE: Duration = Duration::from_millis(400);

/// Sleeps `pause`, or whatever is left of the deadline if that is shorter.
pub(crate) fn sleep_before_retry(deadline: Deadline, pause: Duration) {
    std::thread::sleep(deadline.remaining().min(pause));
}

/// The pause the next retry should use after sleeping `pause`.
pub(crate) fn next_retry_pause(pause: Duration) -> Duration {
    (pause * 2).min(MAXIMUM_RETRY_PAUSE)
}

#[cfg(test)]
#[path = "resolve_pacing_tests.rs"]
mod tests;
