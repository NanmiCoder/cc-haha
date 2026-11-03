/// Why no display server can be reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cause {
    NotConfigured,
    Missing,
    Refused,
}
