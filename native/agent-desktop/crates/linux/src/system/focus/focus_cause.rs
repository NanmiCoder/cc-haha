use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use serde_json::json;

/// Why `focus_window` ended without the window being active. Every cause
/// but a post-send one is decided before anything is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cause {
    WaylandSession,
    NoDisplay,
    NoWindowManager,
    X11Unavailable,
    WindowMinimized,
    WindowHidden,
    WindowNotMapped,
    AmbiguousWindow,
    ActivationNotSent,
    ActivationNotGranted,
    OverviewOpen,
    ActivationRefused,
    FrameNotActive,
    BlockedByModalDialog,
}

impl Cause {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::WaylandSession => "wayland_session",
            Self::NoDisplay => "no_display",
            Self::NoWindowManager => "no_window_manager",
            Self::X11Unavailable => "x11_unavailable",
            Self::WindowMinimized => "window_minimized",
            Self::WindowHidden => "window_hidden",
            Self::WindowNotMapped => "window_not_mapped",
            Self::AmbiguousWindow => "ambiguous_window",
            Self::ActivationNotSent => "activation_not_sent",
            Self::ActivationNotGranted => "activation_not_granted",
            Self::OverviewOpen => "overview_open",
            Self::ActivationRefused => "activation_refused",
            Self::FrameNotActive => "frame_not_active",
            Self::BlockedByModalDialog => "blocked_by_modal_dialog",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::WaylandSession => {
                "A Wayland session lets no client activate another client's window"
            }
            Self::NoDisplay => "No display server answered, so the window cannot be activated",
            Self::NoWindowManager => {
                "No window manager is running, so nothing can activate the window"
            }
            Self::X11Unavailable => "The display server did not describe the window in time",
            Self::WindowMinimized => "The window is minimized and the window manager kept it so",
            Self::WindowHidden => "The window manager reports the window hidden and kept it so",
            Self::WindowNotMapped => "The window is not mapped on the display",
            Self::AmbiguousWindow => {
                "More than one display window matches this window, so none is activated"
            }
            Self::ActivationNotSent => {
                "The activation request could not be sent to the window manager"
            }
            Self::ActivationNotGranted => "The window manager did not grant focus to the window",
            Self::OverviewOpen => {
                "The Activities Overview is open, so the window manager grants no activation"
            }
            Self::ActivationRefused => "The window manager left another window active",
            Self::FrameNotActive => {
                "The window manager made the window active but the application does not report it active"
            }
            Self::BlockedByModalDialog => "A modal dialog of the application took the focus",
        }
    }

    pub(crate) fn suggestion(self) -> &'static str {
        match self {
            Self::ActivationNotGranted => {
                "The window manager granted no activation and no cause could be read; close any overview or lock screen, then retry, or focus the window yourself"
            }
            Self::OverviewOpen => "Close the Activities Overview (press Escape), then retry",
            Self::WaylandSession | Self::NoDisplay | Self::NoWindowManager => {
                "Run the desktop session on X11 with a window manager, or focus the window yourself"
            }
            _ => "Run 'list-windows' to confirm the window, then retry",
        }
    }
}

fn manager_hint(manager: &str) -> String {
    let lower = manager.to_ascii_lowercase();
    if lower.contains("openbox") {
        format!(
            "{manager} lists minimized windows in the client list menu on a middle click of the desktop; choose the window there, then retry"
        )
    } else if lower.contains("gnome") || lower.contains("mutter") {
        format!(
            "{manager} shows minimized windows in the Activities Overview; choose the window there, then retry"
        )
    } else {
        format!(
            "{manager} did not bring the window back; bring it back through {manager}, then retry"
        )
    }
}

/// The refusal after the window manager was asked to bring a minimized or
/// hidden window back and left it hidden. The request went out, so the
/// outcome is not safe to repeat blindly.
pub(crate) fn lift_refusal(cause: Cause, manager: &str) -> AdapterError {
    let manager = if manager.is_empty() {
        "the window manager"
    } else {
        manager
    };
    let state = if cause == Cause::WindowMinimized {
        "minimized"
    } else {
        "hidden"
    };
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("The {state} window was not brought back by {manager}"),
    )
    .with_suggestion(manager_hint(manager))
    .with_details(json!({
        "physical_delivery_started": false,
        "cause": cause.as_str(),
        "window_manager": manager,
    }))
    .with_disposition(DeliverySemantics::delivered_unverified())
}

pub(crate) fn modal_refusal(dialog: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!("{} named '{dialog}'", Cause::BlockedByModalDialog.message()),
    )
    .with_suggestion(format!("Answer or close the dialog '{dialog}', then retry"))
    .with_details(json!({
        "physical_delivery_started": false,
        "cause": Cause::BlockedByModalDialog.as_str(),
        "dialog": dialog,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn refusal(cause: Cause) -> AdapterError {
    use crate::system::display::display_error::{DisplayCause, display_cause_error};
    let display_cause = match cause {
        Cause::NoDisplay => Some(DisplayCause::NotConfigured),
        Cause::X11Unavailable => Some(DisplayCause::Silent),
        _ => None,
    };
    if let Some(display_cause) = display_cause {
        return display_cause_error(&display_cause)
            .with_disposition(DeliverySemantics::not_delivered());
    }
    let code = if cause == Cause::WaylandSession {
        ErrorCode::ActionNotSupported
    } else {
        ErrorCode::ActionFailed
    };
    AdapterError::new(code, cause.message())
        .with_suggestion(cause.suggestion())
        .with_details(json!({
            "physical_delivery_started": false,
            "cause": cause.as_str(),
        }))
        .with_disposition(DeliverySemantics::not_delivered())
}
