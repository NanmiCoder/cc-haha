use crate::system::registry::listed_window::ListedWindow;
use crate::system::x11::X11State;
use crate::system::x11::map::ClientMatch;
use crate::system::x11::twin_tie::{Twins, client_among_twins};

/// The listed windows of one process that share the title of window `index`,
/// and whether the toolkit reports each active.
pub(crate) fn twins_of(listed: &[ListedWindow], index: usize) -> Option<Twins> {
    let own = &listed.get(index)?.frame;
    let mut active = Vec::new();
    let mut me = None;
    for (at, window) in listed.iter().enumerate() {
        if window.frame.pid == own.pid && window.frame.title == own.title {
            if at == index {
                me = Some(active.len());
            }
            active.push(window.active);
        }
    }
    Some(Twins { active, me: me? })
}

/// The X11 client of listed window `index`: its one client by process and
/// title or, among same-titled windows, the client `twin_tie` proves it is.
pub(crate) fn listed_client(
    listed: &[ListedWindow],
    index: usize,
    state: &X11State,
) -> ClientMatch {
    let (Some(window), X11State::Ready { active, clients }) = (listed.get(index), state) else {
        return ClientMatch::NoClient;
    };
    client_among_twins(&window.frame, clients, *active, || twins_of(listed, index))
}

#[cfg(test)]
#[path = "listed_twins_tests.rs"]
mod tests;
