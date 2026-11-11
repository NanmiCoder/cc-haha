use x11rb::protocol::xproto::AtomEnum;

use super::desktop_placement::DesktopPlacement;
use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::x11::control_display::{atoms, longs, open, property};
use crate::system::x11::stacking::stacking_decode::{decode_current_desktop, decode_desktop};

const MAX_CLIENTS: u32 = 4_096;

/// The virtual desktop the session shows and the one each managed window is
/// on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Desktops {
    pub(crate) current: Option<u32>,
    pub(crate) placements: Vec<(u32, DesktopPlacement)>,
}

impl Desktops {
    /// Whether the window is on a desktop other than the one shown. A window
    /// on every desktop, or one whose desktop is unknown, is not.
    pub(crate) fn hides(&self, client: u32) -> bool {
        let Some(current) = self.current else {
            return false;
        };
        self.placements.iter().any(|(id, placement)| {
            *id == client && matches!(placement, DesktopPlacement::On(on) if *on != current)
        })
    }
}

/// Reads the desktops of the session's X11 display, or `None` when the
/// session is not X11 or the window manager publishes none.
pub(crate) fn read() -> Option<Desktops> {
    let DisplayServer::X11(display) = session_server() else {
        return None;
    };
    let (connection, root) = open(&display)?;
    let [current, list, desktop] = <[u32; 3]>::try_from(atoms(
        &connection,
        &[
            b"_NET_CURRENT_DESKTOP",
            b"_NET_CLIENT_LIST",
            b"_NET_WM_DESKTOP",
        ],
    )?)
    .ok()?;
    let current = property(&connection, root, current, AtomEnum::CARDINAL, 1)
        .and_then(|reply| decode_current_desktop(reply.format, &reply.value));
    let listed = property(&connection, root, list, AtomEnum::WINDOW, MAX_CLIENTS)
        .and_then(|reply| longs(reply.format, &reply.value, reply.bytes_after))?;
    let placements = listed
        .into_iter()
        .filter_map(|window| {
            let reply = property(&connection, window, desktop, AtomEnum::CARDINAL, 1)?;
            Some((window, decode_desktop(reply.format, &reply.value)))
        })
        .collect();
    Some(Desktops {
        current,
        placements,
    })
}

#[cfg(test)]
#[path = "desktops_tests.rs"]
mod tests;
