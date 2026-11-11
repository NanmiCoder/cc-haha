/// What the process id names now, compared with the token it had when the
/// caller saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Identity {
    Gone,
    Same,
    Replaced,
    Unreadable,
}
