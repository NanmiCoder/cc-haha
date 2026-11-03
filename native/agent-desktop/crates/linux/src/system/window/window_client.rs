use agent_desktop_core::WindowInfo;

use crate::system::focus::focus_cause::Cause;
use crate::system::x11::FrameFacts;
use crate::system::x11::X11Client;
use crate::system::x11::map::{ClientMatch, match_client};
use crate::system::x11::twin_tie::{Twins, broken_tie};
use crate::tree::Extents;

/// What the mapping of a window to its X11 client reads from the world: the
/// window's toolkit decides whether its reported position is global.
pub(crate) trait ClientWorld {
    fn global_position(&self) -> bool;

    /// The frames of the window's process that share its title, when this
    /// world reads them. A world that does not leaves a tie between clients
    /// a tie.
    fn twins(&self, _win: &WindowInfo) -> Option<Twins> {
        None
    }
}

pub(crate) fn facts_of(win: &WindowInfo, global_position: bool) -> FrameFacts {
    FrameFacts {
        size_identity: false,
        pid: win.pid.get(),
        title: win.title.clone(),
        extents: win.bounds.map(|rect| Extents {
            x: rect.x as i32,
            y: rect.y as i32,
            width: rect.width as i32,
            height: rect.height as i32,
        }),
        global_position,
    }
}

pub(crate) fn client_of(
    world: &impl ClientWorld,
    win: &WindowInfo,
    clients: &[X11Client],
    active_client: impl FnOnce() -> Option<u32>,
) -> Result<u32, Cause> {
    let mut found = match_client(&facts_of(win, false), clients);
    if matches!(found, ClientMatch::Several(_)) {
        found = match_client(&facts_of(win, world.global_position()), clients);
    }
    if let ClientMatch::Several(ids) = &found
        && let Some(twins) = world.twins(win)
        && let Some(id) = broken_tie(ids, active_client(), &twins)
    {
        found = ClientMatch::One(id);
    }
    match found {
        ClientMatch::One(id) => Ok(id),
        ClientMatch::Several(_) => Err(Cause::AmbiguousWindow),
        ClientMatch::NoClient => Err(Cause::WindowNotMapped),
    }
}
