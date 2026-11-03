use std::collections::HashSet;

use crate::system::registry::listed_window::ListedWindow;
use crate::system::x11::map::{ClientMatch, match_client};
use crate::system::x11::{X11Client, X11State};

fn clients_of(state: &X11State) -> &[X11Client] {
    match state {
        X11State::Ready { clients, .. } => clients,
        _ => &[],
    }
}

fn matched(window: &ListedWindow, clients: &[X11Client]) -> Vec<u32> {
    match match_client(&window.frame, clients) {
        ClientMatch::One(id) => vec![id],
        ClientMatch::Several(ids) => ids,
        ClientMatch::NoClient => Vec::new(),
    }
}

/// Removes the husks of closed windows. A toolkit that keeps a top-level
/// window for reuse leaves it on the registry after it hides or closes, with
/// neither `SHOWING` nor `ICONIFIED`. No live window measured lacks both: a
/// minimized one shows or is iconified, and one on another desktop shows.
/// An unshown window stays only when the display server shows it is not a
/// husk: its client is the only claimant of a managed X11 window of the same
/// process. A minimized window the window manager still manages is kept,
/// while the husk of a reopened dialog, whose client belongs to the live
/// dialog, is dropped.
pub(crate) fn without_ghosts(windows: Vec<ListedWindow>, state: &X11State) -> Vec<ListedWindow> {
    if !windows.iter().any(|window| window.unshown) {
        return windows;
    }
    let clients = clients_of(state);
    let claimed: HashSet<u32> = windows
        .iter()
        .filter(|window| !window.unshown)
        .flat_map(|window| matched(window, clients))
        .collect();
    windows
        .into_iter()
        .filter(|window| {
            !window.unshown
                || matched(window, clients)
                    .iter()
                    .any(|client| !claimed.contains(client))
        })
        .collect()
}

#[cfg(test)]
#[path = "ghost_window_tests.rs"]
mod tests;
