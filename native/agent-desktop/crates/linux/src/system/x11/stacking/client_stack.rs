use x11rb::protocol::xproto::AtomEnum;

use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::x11::control_display::{atoms, longs, open, property};

const MAX_CLIENTS: u32 = 4_096;

/// The managed windows of the session's X11 display from the bottom of the
/// stacking order to the top, or `None` when the session is not X11 or the
/// window manager publishes no stacking list.
pub(crate) fn read() -> Option<Vec<u32>> {
    let DisplayServer::X11(display) = session_server() else {
        return None;
    };
    let (connection, root) = open(&display)?;
    let [list] = <[u32; 1]>::try_from(atoms(&connection, &[b"_NET_CLIENT_LIST_STACKING"])?).ok()?;
    property(&connection, root, list, AtomEnum::WINDOW, MAX_CLIENTS)
        .and_then(|reply| longs(reply.format, &reply.value, reply.bytes_after))
        .filter(|stack| !stack.is_empty())
}
