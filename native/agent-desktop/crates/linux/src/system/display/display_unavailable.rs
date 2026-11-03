use super::display_cause::Cause;

/// A session with no reachable display server: the cause, and the variables
/// and addresses that were tried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Unavailable {
    pub(crate) cause: Cause,
    pub(crate) detail: String,
}
