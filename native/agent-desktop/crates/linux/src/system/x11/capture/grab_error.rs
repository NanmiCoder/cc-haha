use agent_desktop_core::{AdapterError, ErrorCode};
use x11rb::protocol::ErrorKind;

use super::map_state::MapState;
use crate::system::x11::MonitorFault;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GrabError {
    Gone,
    Unviewable,
    OffScreen,
    Resource,
    Fault(MonitorFault),
    Timeout,
    UnprovenPaint,
}

pub(crate) fn unreadable<E>(_: E) -> GrabError {
    GrabError::Fault(MonitorFault::Unreadable)
}

impl GrabError {
    pub(crate) fn from_error_kind(kind: ErrorKind, map_state: impl FnOnce() -> MapState) -> Self {
        match kind {
            ErrorKind::Window | ErrorKind::Drawable => Self::Gone,
            ErrorKind::Alloc => Self::Resource,
            ErrorKind::Match => match map_state() {
                MapState::Viewable => Self::OffScreen,
                MapState::Unviewable | MapState::Unmapped => Self::Unviewable,
            },
            _ => Self::Fault(MonitorFault::Unreadable),
        }
    }
}

impl From<GrabError> for AdapterError {
    fn from(error: GrabError) -> Self {
        let failed = |message: &str| AdapterError::new(ErrorCode::ActionFailed, message);
        match error {
            GrabError::Gone => AdapterError::new(
                ErrorCode::WindowNotFound,
                "The window no longer exists on the display",
            ),
            GrabError::Unviewable => {
                failed("The window is not visible, so it has no pixels to capture")
            }
            GrabError::OffScreen => failed("The window is not fully on the screen"),
            GrabError::Resource => failed("The display server could not allocate the capture"),
            GrabError::Fault(MonitorFault::Unreachable(address)) => AdapterError::new(
                ErrorCode::PlatformNotSupported,
                format!("No display server answers at {address}"),
            ),
            GrabError::Fault(MonitorFault::Denied(reason)) => AdapterError::new(
                ErrorCode::PlatformNotSupported,
                format!("The display server refused the capture connection: {reason}"),
            ),
            GrabError::Fault(MonitorFault::Unreadable) => {
                failed("The display server sent a reply capture cannot use")
            }
            GrabError::Timeout => {
                AdapterError::timeout("The display server did not answer in time")
            }
            GrabError::UnprovenPaint => failed("The window's own paint could not be proven"),
        }
    }
}

#[cfg(test)]
#[path = "grab_error_tests.rs"]
mod tests;
