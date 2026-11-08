use agent_desktop_core::{AdapterError, Deadline, ErrorCode, WindowInfo};

use crate::system::SharedBus;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::registry::read_registry;
use crate::system::window::listed_twins::listed_client;
use crate::system::window::window_ops::windows_of;
use crate::system::x11::map::{ClientMatch, match_client};
use crate::system::x11::stacking::stacking_source::StackingSource;
use crate::system::x11::{DisplayReader, FrameFacts, X11State};

/// What mapping a listed window to the X11 clients of its session found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum XidOutcome {
    One(u32),
    Several(Vec<u32>),
    NoClient,
    NoManager,
    Unavailable,
}

/// The outcome for one window's frame facts against what the display server
/// and its window manager reported.
pub(crate) fn outcome_of(state: X11State, frame: &FrameFacts) -> XidOutcome {
    match state {
        X11State::Unavailable => XidOutcome::Unavailable,
        X11State::NoWindowManager => XidOutcome::NoManager,
        X11State::Ready { clients, .. } => match match_client(frame, &clients) {
            ClientMatch::One(id) => XidOutcome::One(id),
            ClientMatch::Several(ids) => XidOutcome::Several(ids),
            ClientMatch::NoClient => XidOutcome::NoClient,
        },
    }
}

fn settled(state: &X11State, listed: &[ListedWindow], window: &WindowInfo) -> XidOutcome {
    let Some(index) = listed
        .iter()
        .position(|candidate| candidate.info.id == window.id)
    else {
        return XidOutcome::Unavailable;
    };
    let outcome = outcome_of(state.clone(), &listed[index].frame);
    if !matches!(outcome, XidOutcome::Several(_)) {
        return outcome;
    }
    match listed_client(listed, index, state) {
        ClientMatch::One(id) => XidOutcome::One(id),
        ClientMatch::Several(_) | ClientMatch::NoClient => outcome,
    }
}

/// The X11 window id of a listed window, from its frame facts and the
/// managed clients. Nothing is guessed: only one match is an id.
pub(crate) fn window_xid(bus: &SharedBus, window: &WindowInfo, deadline: Deadline) -> XidOutcome {
    let Ok(registry) = read_registry(bus, deadline) else {
        return XidOutcome::Unavailable;
    };
    let Ok(listed) = windows_of(
        bus,
        &registry,
        |app| app.root.pid() == u32::from(window.pid),
        deadline,
    ) else {
        return XidOutcome::Unavailable;
    };
    settled(&DisplayReader.clients_within(deadline), &listed, window)
}

fn refusal(code: ErrorCode, message: &str, suggestion: &str) -> AdapterError {
    AdapterError::new(code, message).with_suggestion(suggestion)
}

/// The id a capture may use, or the named error for every other outcome.
pub(crate) fn xid_or_error(outcome: XidOutcome) -> Result<u32, AdapterError> {
    match outcome {
        XidOutcome::One(id) => Ok(id),
        XidOutcome::Several(ids) => Err(refusal(
            ErrorCode::AmbiguousTarget,
            "More than one X11 window matches this window",
            "Close the duplicate windows or give them distinct titles, then retry",
        )
        .with_details(serde_json::json!({ "candidates": ids.len() }))),
        XidOutcome::NoClient => Err(refusal(
            ErrorCode::ActionFailed,
            "No X11 window of the window manager matches this window",
            "Run 'list-windows' to refresh the window, then retry",
        )),
        XidOutcome::NoManager => Err(refusal(
            ErrorCode::PlatformNotSupported,
            "A window cannot be captured without a running window manager",
            "Start a window manager in this X11 session, or capture the screen instead",
        )),
        XidOutcome::Unavailable => Err(refusal(
            ErrorCode::PlatformNotSupported,
            "The X11 display could not be read to find the window",
            "Run inside an X11 session whose display answers",
        )),
    }
}

#[cfg(test)]
#[path = "window_xid_tests.rs"]
mod tests;
