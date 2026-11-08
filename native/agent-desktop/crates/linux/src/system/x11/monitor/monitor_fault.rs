use x11rb::errors::ConnectError;

/// Why the monitor list could not be read, as far as the connection says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MonitorFault {
    /// The server answered and refused this client: a permanent condition.
    Denied(String),
    /// No server answered at the address the display names.
    Unreachable(String),
    /// A connection was made and its replies could not be used.
    Unreadable,
}

/// Maps a failed connect to the fault it shows.
pub(crate) fn fault_of_connect(error: &ConnectError) -> MonitorFault {
    match error {
        ConnectError::SetupAuthenticate(rejected) => {
            MonitorFault::Denied(String::from_utf8_lossy(&rejected.reason).trim().to_owned())
        }
        ConnectError::SetupFailed(rejected) => {
            MonitorFault::Denied(String::from_utf8_lossy(&rejected.reason).trim().to_owned())
        }
        ConnectError::IoError(io) => MonitorFault::Unreachable(io.to_string()),
        ConnectError::DisplayParsingError(_) | ConnectError::InvalidScreen => {
            MonitorFault::Unreachable(error.to_string())
        }
        _ => MonitorFault::Unreadable,
    }
}

#[cfg(test)]
#[path = "monitor_fault_tests.rs"]
mod tests;
