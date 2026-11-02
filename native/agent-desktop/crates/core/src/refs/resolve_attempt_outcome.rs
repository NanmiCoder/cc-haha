use crate::{AdapterError, adapter::NativeHandle};

pub(crate) enum ResolveAttemptOutcome {
    Resolved(NativeHandle),
    Failed(AdapterError),
    DeadlinePassed,
}
