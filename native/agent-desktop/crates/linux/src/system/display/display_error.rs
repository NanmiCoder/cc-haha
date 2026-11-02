//! The cause of an unreachable display server and the one error each cause
//! maps to. Every subsystem that routes by display server reports through
//! this mapping so the same cause carries the same code everywhere.

use agent_desktop_core::{AdapterError, ErrorCode};

/// Why a display server cannot be reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DisplayCause {
    NotConfigured,
    Missing { address: String },
    Refused { detail: String },
    Silent,
    AuthRefused { reason: String },
}

impl DisplayCause {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::NotConfigured => "not_configured",
            Self::Missing { .. } => "missing",
            Self::Refused { .. } => "refused",
            Self::Silent => "silent",
            Self::AuthRefused { .. } => "auth_refused",
        }
    }
}

/// The one error a display cause maps to. Every cause but `Silent` is
/// permanent and reports `PLATFORM_NOT_SUPPORTED`; `Silent` is `TIMEOUT`.
pub(crate) fn display_cause_error(cause: &DisplayCause) -> AdapterError {
    let mut error = match cause {
        DisplayCause::NotConfigured => AdapterError::new(
            ErrorCode::PlatformNotSupported,
            "No display server is configured in this session",
        )
        .with_suggestion("Run inside a desktop session with DISPLAY or WAYLAND_DISPLAY set")
        .with_details(serde_json::json!({
            "display_unavailable": cause.as_str(),
            "detail": "",
        })),
        DisplayCause::Missing { address } => AdapterError::new(
            ErrorCode::PlatformNotSupported,
            format!("The session's display server is not running: {address}"),
        )
        .with_suggestion("Start the display server, or correct DISPLAY and WAYLAND_DISPLAY")
        .with_details(serde_json::json!({
            "display_unavailable": cause.as_str(),
            "detail": address,
        })),
        DisplayCause::Refused { detail } => AdapterError::new(
            ErrorCode::PlatformNotSupported,
            format!("The session's display server refused the connection: {detail}"),
        )
        .with_suggestion(
            "Check that the display server accepts this user, or correct DISPLAY and WAYLAND_DISPLAY",
        )
        .with_details(serde_json::json!({
            "display_unavailable": cause.as_str(),
            "detail": detail,
        })),
        DisplayCause::Silent => {
            AdapterError::timeout("The display server did not answer in time")
                .with_suggestion("Retry, or check that DISPLAY names a server that is running")
        }
        DisplayCause::AuthRefused { reason } => AdapterError::new(
            ErrorCode::PlatformNotSupported,
            format!("The session's display server refused the connection: {reason}"),
        )
        .with_suggestion(
            "Check that the display server accepts this user, or correct DISPLAY and WAYLAND_DISPLAY",
        )
        .with_details(serde_json::json!({
            "display_unavailable": cause.as_str(),
            "detail": reason,
        })),
    };
    let mut details = error
        .details
        .take()
        .unwrap_or_else(|| serde_json::json!({}));
    details["display_unavailable"] = cause.as_str().into();
    details["retryable"] = matches!(cause, DisplayCause::Silent).into();
    error.with_details(details)
}
