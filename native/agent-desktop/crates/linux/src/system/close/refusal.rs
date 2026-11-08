use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use serde_json::json;

use super::Request;
use super::standing::Standing;
use crate::system::x11::control::control_error::ControlError;
use crate::system::x11::window::toplevel::Toplevel;
use crate::system::x11::window::window_kind::WindowKind;

const RESIDENT: &str = "The app has no open window and may stay resident after its last window closes. Use --force to end the process.";
const PROMPT: &str = "A prompt, such as one asking to save, may be open. Answer it in the app, or use --force, which discards unsaved work.";
const FORCE: &str =
    "Retry with --force to end the process without a close request; it discards unsaved work.";

fn refused(code: ErrorCode, message: impl Into<String>) -> AdapterError {
    AdapterError::new(code, message).with_disposition(DeliverySemantics::not_delivered())
}

pub(super) fn protected(identifier: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::InvalidArgs,
        format!("'{identifier}' is a protected session process and cannot be closed"),
    )
    .with_suggestion(
        "Target a regular application; processes the desktop session needs are never closed.",
    )
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(super) fn missing_token(request: &Request<'_>) -> AdapterError {
    refused(
        ErrorCode::InvalidArgs,
        "Exact close requires a process instance token",
    )
    .with_suggestion("Take the app from 'list-apps' and pass its process_instance.")
    .with_details(json!({ "app": request.name, "pid": request.pid }))
}

pub(super) fn unreadable(request: &Request<'_>) -> AdapterError {
    refused(
        ErrorCode::ActionFailed,
        format!(
            "Process {} could not be read, so it was not closed",
            request.pid
        ),
    )
}

pub(super) fn no_route(request: &Request<'_>) -> AdapterError {
    refused(
        ErrorCode::ActionNotSupported,
        "A close request needs an X11 session with a window manager; this session has none",
    )
    .with_suggestion(FORCE)
    .with_details(json!({ "app": request.name, "pid": request.pid }))
}

pub(super) fn wayland_session(request: &Request<'_>) -> AdapterError {
    refused(
        ErrorCode::ActionNotSupported,
        "A Wayland compositor has no close request for another client's window",
    )
    .with_suggestion(FORCE)
    .with_details(json!({
        "cause": "wayland_session",
        "app": request.name,
        "pid": request.pid,
    }))
}

pub(super) fn windowless(request: &Request<'_>) -> AdapterError {
    refused(
        ErrorCode::ActionFailed,
        format!(
            "No window of process {} could receive a close request",
            request.pid
        ),
    )
    .with_suggestion(RESIDENT)
    .with_details(json!({ "app": request.name, "pid": request.pid }))
}

pub(super) fn send_failed(request: &Request<'_>, error: ControlError) -> AdapterError {
    refused(
        ErrorCode::ActionFailed,
        format!("The close request to process {} failed", request.pid),
    )
    .with_platform_detail(format!("{error:?}"))
    .with_suggestion(FORCE)
    .with_details(json!({ "app": request.name, "pid": request.pid }))
}

pub(super) fn unavailable(request: &Request<'_>) -> AdapterError {
    refused(
        ErrorCode::ActionFailed,
        "The display server could not be reached for a close request",
    )
    .with_suggestion(FORCE)
    .with_details(json!({ "app": request.name, "pid": request.pid }))
}

pub(super) fn is_dialog(window: &Toplevel) -> bool {
    window.kind == WindowKind::Dialog || window.transient
}

fn dialogs_in(windows: &[Toplevel]) -> usize {
    windows.iter().filter(|window| is_dialog(window)).count()
}

/// A save prompt or another dialog of the process is open, as a top-level
/// window or drawn inside one. A close request to it would answer it for the
/// user, so none is sent. `sent` says whether a request to the process's other
/// windows went out in this call, which is what opened the dialog.
pub(super) fn dialog_pending(
    request: &Request<'_>,
    standing: &Standing,
    sent: bool,
) -> AdapterError {
    let titles: Vec<&str> = standing
        .windows
        .iter()
        .filter(|window| is_dialog(window))
        .map(|window| window.title.as_str())
        .chain(standing.nested.iter().map(String::as_str))
        .collect();
    let dialogs = titles.len();
    let delivery = if sent {
        DeliverySemantics::delivered_unverified()
    } else {
        DeliverySemantics::not_delivered()
    };
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!(
            "Process {} has {dialogs} open dialog(s), so no close request was sent to them",
            request.pid
        ),
    )
    .with_suggestion(PROMPT)
    .with_details(json!({
        "cause": "dialog_pending",
        "app": request.name,
        "pid": request.pid,
        "windows_remaining": standing.windows.len() - dialogs_in(&standing.windows),
        "dialogs": dialogs,
        "dialog_titles": titles,
        "dialog": titles.first(),
    }))
    .with_disposition(delivery)
}

pub(super) fn waited_out(
    timeout: AdapterError,
    request: &Request<'_>,
    remaining: Option<&[Toplevel]>,
) -> AdapterError {
    let mut details = json!({
        "app": request.name,
        "pid": request.pid,
        "force": request.force,
    });
    let mut error = timeout;
    if let Some(windows) = remaining {
        let dialogs = dialogs_in(windows);
        details["windows_remaining"] = json!(windows.len() - dialogs);
        details["dialogs"] = json!(dialogs);
        error = error.with_suggestion(if windows.is_empty() { RESIDENT } else { PROMPT });
    }
    error
        .with_details(details)
        .with_disposition(DeliverySemantics::delivered_unverified())
}
