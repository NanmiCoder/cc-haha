use std::time::Duration;

/// What to do after a walk of a tree that may still be filling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    Settled,
    Wait(Duration),
    GiveUp,
}
