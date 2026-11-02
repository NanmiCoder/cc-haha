/// What the accessibility probe of a process answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::system) enum Probe {
    Answered,
    TimedOut,
    Unavailable,
}
