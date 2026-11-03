#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ControlError {
    NoDisplay,
    SendFailed,
    BadWindow,
    StaleWindow,
    TimedOut,
}
