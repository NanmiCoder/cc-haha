use std::time::Duration;

use agent_desktop_core::Deadline;

use crate::system::display::display_server::DisplayServer;

use super::map::ClientMatch;
use super::stacking::stacking_read::StackingRead;
use super::stacking::stacking_source::StackingSource;
use super::twin_tie::{Twins, client_among_twins, tied_agree};
use super::window::frame_window::FrameWindow;
use super::window::window_x11_state::WindowX11State;
use super::{FrameFacts, X11State, start};

/// How long one stacking read may take on the real display. A read is a
/// handful of pipelined round trips, 2 to 4 ms in `L27-3`.
pub(super) const READ_BUDGET: Duration = Duration::from_millis(1_500);

/// The deadline of a read with no caller to share one with.
#[cfg(test)]
pub(super) fn standard_deadline() -> Option<Deadline> {
    Deadline::from_duration(READ_BUDGET).ok()
}

/// The budget of one read: the read budget, cut to what the caller has left.
pub(super) fn capped(caller: Deadline) -> Option<Deadline> {
    Deadline::from_duration(READ_BUDGET.min(caller.remaining())).ok()
}

/// Runs a display-server read on its own thread and gives up with `fallback`
/// when `deadline` passes first, shutting down any registered display socket
/// so a blocked round trip releases its worker.
pub(in crate::system) fn bounded<T: Send + 'static>(
    deadline: Deadline,
    fallback: T,
    read: impl FnOnce() -> T + Send + 'static,
) -> T {
    start(read).finish(deadline).unwrap_or(fallback)
}

/// Chooses where a stacking read goes from what the shared detector says
/// about the session. Wayland and a missing display answer without a
/// connection being opened: a Wayland desktop's windows are not X11 evidence
/// even when Xwayland is up.
pub(super) fn route(
    server: DisplayServer,
    read: impl FnOnce(String) -> StackingRead,
) -> StackingRead {
    match server {
        DisplayServer::X11(display) => read(display),
        DisplayServer::Wayland => StackingRead::NotX11,
        DisplayServer::Unavailable(..) => StackingRead::Unavailable,
    }
}

/// The X11 client of a listed window and its state. Several clients that
/// share the frame's process and title are told apart by `twins`, which is
/// read only for such a tie; a tie nothing breaks is reported as one.
pub(crate) fn frame_window_state(
    source: &dyn StackingSource,
    deadline: Deadline,
    frame: &FrameFacts,
    twins: impl FnOnce() -> Option<Twins>,
) -> FrameWindow {
    let X11State::Ready { active, clients } = source.clients_within(deadline) else {
        return FrameWindow::Unknown;
    };
    let client_id = match client_among_twins(frame, &clients, active, twins) {
        ClientMatch::One(id) => id,
        ClientMatch::Several(ids) => {
            return FrameWindow::Tied {
                hidden: tied_agree(&clients, &ids, |client| client.hidden),
            };
        }
        ClientMatch::NoClient => return FrameWindow::Unknown,
    };
    if deadline.is_expired() {
        return FrameWindow::Unknown;
    }
    let StackingRead::Ready(snapshot) = source.read_within(client_id, deadline) else {
        return FrameWindow::Unknown;
    };
    if deadline.is_expired() {
        return FrameWindow::Unknown;
    }
    let Some(window) = snapshot.stack.iter().find(|window| window.id == client_id) else {
        return FrameWindow::Unknown;
    };
    FrameWindow::Client(WindowX11State {
        client_id,
        hidden: window.flags.hidden,
        client_origin: (window.client.x, window.client.y),
        shadow: window.shadow,
    })
}

pub(crate) mod client_stack;
pub(super) mod overlays;
pub(super) mod root_stack_evidence;
pub(super) mod stack_selection;
pub(crate) mod stacked_window;
pub(super) mod stacking_atoms;
pub(crate) mod stacking_decode;
pub(super) mod stacking_input;
pub(crate) mod stacking_read;
pub(crate) mod stacking_snapshot;
pub(crate) mod stacking_source;
pub(super) mod stacking_wire;
#[cfg(test)]
#[path = "stacking_tests.rs"]
mod tests;
pub(crate) mod type_atoms;
