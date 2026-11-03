use crate::{AdapterError, Deadline};

/// An owned hint to resample a wait predicate, never evidence that it matched.
/// Registration must finish before returning the subscription. Changes since
/// registration remain latched across predicate reads until `wait` consumes them.
/// Loss or overflow wakes the reader to resample; drop cancels and joins any
/// owned worker without waiting for another native event.
pub trait WaitWakeup: Send {
    /// Returns on a pending change or by the supplied deadline. Errors retire
    /// the subscription and leave the caller using bounded predicate polling.
    fn wait(&mut self, deadline: Deadline) -> Result<(), AdapterError>;
}
