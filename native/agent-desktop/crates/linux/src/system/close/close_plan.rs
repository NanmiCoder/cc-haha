use std::time::Duration;

pub(in crate::system) const TERM_GRACE: Duration = Duration::from_millis(2_000);

/// The grace between `SIGTERM` and `SIGKILL`: the measured grace, never more
/// than half of what is left of the budget, so `SIGKILL` and its wait still
/// fit.
pub(in crate::system) fn grace_within(remaining: Duration) -> Duration {
    TERM_GRACE.min(remaining / 2)
}
