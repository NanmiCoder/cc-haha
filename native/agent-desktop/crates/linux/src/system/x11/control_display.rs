use agent_desktop_core::Deadline;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{Atom, ConnectionExt, GetPropertyReply, Window};
use x11rb::rust_connection::RustConnection;

use super::control::ControlRead;
use super::control::activate_error::ActivateError;
use super::stacking::bounded;
use crate::system::display::display_server::{DisplayServer, session_server};

/// The display window control reaches: the X11 session's own, or on a
/// Wayland session the display of its Xwayland, which `DISPLAY` names.
pub(super) fn x11_display() -> Option<String> {
    match session_server() {
        DisplayServer::X11(display) => Some(display),
        DisplayServer::Wayland => xwayland_display(),
        DisplayServer::Unavailable(..) => None,
    }
}

fn xwayland_display() -> Option<String> {
    std::env::var("DISPLAY")
        .ok()
        .filter(|display| !display.is_empty())
}

pub(super) fn connect() -> Result<(RustConnection, u32), ActivateError> {
    let display = x11_display().ok_or(ActivateError::NoDisplay)?;
    open(&display).ok_or(ActivateError::NoDisplay)
}

/// Runs a read of the session's display on a bounded thread. A Wayland
/// session with no Xwayland answering is `NotX11`, and a session with no
/// display is `Unavailable`, both without a connection being kept.
pub(super) fn route<T: Send + 'static>(
    deadline: Deadline,
    read: impl FnOnce(String) -> ControlRead<T> + Send + 'static,
) -> ControlRead<T> {
    route_for(session_server(), xwayland_display(), deadline, read)
}

pub(super) fn route_for<T: Send + 'static>(
    server: DisplayServer,
    xwayland: Option<String>,
    deadline: Deadline,
    read: impl FnOnce(String) -> ControlRead<T> + Send + 'static,
) -> ControlRead<T> {
    match (server, xwayland) {
        (DisplayServer::X11(display), _) => {
            bounded(deadline, ControlRead::Unavailable, move || read(display))
        }
        (DisplayServer::Wayland, Some(display)) => {
            match bounded(deadline, ControlRead::Unavailable, move || read(display)) {
                ControlRead::Unavailable => ControlRead::NotX11,
                answered => answered,
            }
        }
        (DisplayServer::Wayland, None) => ControlRead::NotX11,
        (DisplayServer::Unavailable(..), _) => ControlRead::Unavailable,
    }
}

pub(crate) fn open(display: &str) -> Option<(RustConnection, Window)> {
    let (connection, screen) = super::bounded::connect(display).ok()?;
    let root = connection.setup().roots.get(screen)?.root;
    Some((connection, root))
}

/// The atoms of `names`, interned in one pipelined round trip.
pub(super) fn atoms(connection: &RustConnection, names: &[&[u8]]) -> Option<Vec<Atom>> {
    let cookies: Vec<_> = names
        .iter()
        .map(|name| connection.intern_atom(false, name).ok())
        .collect::<Option<_>>()?;
    cookies
        .into_iter()
        .map(|cookie| cookie.reply().ok().map(|reply| reply.atom))
        .collect()
}

pub(super) fn property(
    connection: &RustConnection,
    window: Window,
    name: Atom,
    kind: impl Into<Atom>,
    longs: u32,
) -> Option<GetPropertyReply> {
    connection
        .get_property(false, window, name, kind, 0, longs)
        .ok()?
        .reply()
        .ok()
}

/// The 32-bit values of a property, empty when the property is absent. A
/// value of another width or one cut short by the length asked for is `None`,
/// which reads as unknown and never as empty.
pub(super) fn longs(format: u8, value: &[u8], bytes_after: u32) -> Option<Vec<u32>> {
    if bytes_after != 0 {
        return None;
    }
    if value.is_empty() {
        return Some(Vec::new());
    }
    super::snapshot::decode_cardinals(format, value)
}
