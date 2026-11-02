/// Why an activation request could not be sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActivateError {
    /// No display server accepted the connection.
    NoDisplay,
    /// The connection broke while the request was being written.
    SendFailed,
}
