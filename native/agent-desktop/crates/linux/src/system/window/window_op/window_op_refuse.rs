use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use serde_json::json;

use crate::system::focus::focus_cause::Cause;
use crate::system::x11::X11Client;
use crate::system::x11::control::ControlRead;
use crate::system::x11::control::control_error::ControlError;

pub(super) fn refused(
    code: ErrorCode,
    cause: &str,
    message: &str,
    suggestion: &str,
) -> AdapterError {
    AdapterError::new(code, message)
        .with_suggestion(suggestion)
        .with_details(json!({ "cause": cause, "physical_delivery_started": false }))
        .with_disposition(DeliverySemantics::not_delivered())
}

pub(super) fn unreadable() -> AdapterError {
    refused(
        ErrorCode::ActionFailed,
        "x11_unavailable",
        "The display server did not describe the window in time",
        "Run 'list-windows' to confirm the window, then retry",
    )
}

pub(super) fn unsupported_session(read: &ControlRead<Vec<X11Client>>) -> AdapterError {
    match read {
        ControlRead::NotX11 => refused(
            ErrorCode::ActionNotSupported,
            "wayland_session",
            "A Wayland session lets no client move, resize, minimize or maximize another client's window",
            "Run the desktop session on X11 with a window manager, or operate the window yourself",
        ),
        ControlRead::NoManager => refused(
            ErrorCode::ActionNotSupported,
            "no_window_manager",
            "No window manager is running, so nothing can apply the request",
            "Run the desktop session with a window manager, or operate the window yourself",
        ),
        ControlRead::Ready(_) | ControlRead::Unavailable => unreadable(),
    }
}

pub(super) fn no_client(cause: Cause) -> AdapterError {
    match cause {
        Cause::AmbiguousWindow => AdapterError::ambiguous_target(
            "More than one display window matches this window, so none is changed",
        )
        .with_suggestion("Give the windows different titles, then retry")
        .with_details(json!({ "cause": cause.as_str(), "physical_delivery_started": false }))
        .with_disposition(DeliverySemantics::not_delivered()),
        _ => refused(
            ErrorCode::ActionNotSupported,
            cause.as_str(),
            "The window has no client on the display, so it cannot be changed from here",
            "Run 'list-windows' to confirm the window is mapped, then retry",
        ),
    }
}

pub(super) fn write_failed(error: ControlError) -> AdapterError {
    match error {
        ControlError::StaleWindow => {
            AdapterError::stale_ref_because("The window owner changed or could not be verified")
                .with_disposition(DeliverySemantics::not_delivered())
        }
        ControlError::BadWindow => refused(
            ErrorCode::WindowNotFound,
            "window_destroyed",
            "The window no longer exists on the display",
            "Run 'list-windows' to find the window again",
        ),
        ControlError::NoDisplay => unreadable(),
        ControlError::TimedOut => {
            AdapterError::timeout("The display server did not accept the request in time")
                .with_disposition(DeliverySemantics::not_delivered())
        }
        ControlError::SendFailed => AdapterError::new(
            ErrorCode::ActionFailed,
            "The request could not be written to the display server",
        )
        .with_suggestion("Run 'list-windows' to see whether the window changed, then retry")
        .with_disposition(DeliverySemantics::uncertain()),
    }
}
