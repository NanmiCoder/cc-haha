use std::time::Duration;

use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt, CreateWindowAux, EventMask, PropMode, WindowClass,
};
use x11rb::rust_connection::RustConnection;

use super::activate_error::ActivateError;
use crate::system::x11::stacking::bounded;

/// How long a window manager gets to make the window active before the
/// request counts as ignored. Openbox answered within 2 to 4 ms (`L27-3`).
pub(crate) const ACTIVATION_GRACE: Duration = Duration::from_millis(2_000);

const EVENT_POLL: Duration = Duration::from_millis(2);

pub(in crate::system::x11) fn connect() -> Result<(RustConnection, u32), ActivateError> {
    let display = match crate::system::display::display_server::session_server() {
        crate::system::display::display_server::DisplayServer::X11(display) => display,
        _ => return Err(ActivateError::NoDisplay),
    };
    let (connection, screen) =
        crate::system::x11::bounded::connect(&display).map_err(|_| ActivateError::NoDisplay)?;
    let root = connection
        .setup()
        .roots
        .get(screen)
        .map(|screen| screen.root)
        .ok_or(ActivateError::NoDisplay)?;
    Ok((connection, root))
}

fn atom(connection: &RustConnection, name: &[u8]) -> Result<Atom, ActivateError> {
    connection
        .intern_atom(false, name)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|reply| reply.atom)
        .ok_or(ActivateError::SendFailed)
}

/// The display server's current time, the stamp a request made now should
/// carry. A server only tells its time through an event, so a property on a
/// window made for the purpose is touched and the notification polled for
/// until `deadline`.
pub(in crate::system::x11) fn server_time(
    connection: &RustConnection,
    root: u32,
    deadline: agent_desktop_core::Deadline,
) -> Option<u32> {
    let property = atom(connection, b"WM_CLASS").ok()?;
    let window = connection.generate_id().ok()?;
    connection
        .create_window(
            0,
            window,
            root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_ONLY,
            0,
            &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
        )
        .ok()?;
    connection
        .change_property(
            PropMode::APPEND,
            window,
            property,
            AtomEnum::STRING,
            8,
            0,
            &[],
        )
        .ok()?;
    connection.flush().ok()?;
    let stamp = loop {
        match connection.poll_for_event() {
            Ok(Some(Event::PropertyNotify(event))) => break Some(event.time),
            Ok(Some(_)) => {}
            Ok(None) if deadline.is_expired() => break None,
            Ok(None) => std::thread::sleep(EVENT_POLL.min(deadline.remaining())),
            Err(_) => break None,
        }
    };
    let _ = connection.destroy_window(window);
    let _ = connection.flush();
    stamp
}

/// The window the manager says is active, or `None` when it names none or
/// cannot be asked.
fn active_window() -> Option<u32> {
    let (connection, root) = connect().ok()?;
    let active = atom(&connection, b"_NET_ACTIVE_WINDOW").ok()?;
    first_window(&connection, root, active)
}

/// The first window the property holds, or `None` when it is unset, names no
/// window or cannot be read.
pub(crate) fn first_window(
    connection: &RustConnection,
    window: u32,
    property: Atom,
) -> Option<u32> {
    let reply = connection
        .get_property(false, window, property, AtomEnum::WINDOW, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    let bytes: [u8; 4] = reply.value.get(..4)?.try_into().ok()?;
    Some(u32::from_ne_bytes(bytes)).filter(|id| *id != 0)
}

fn deadline_of(budget: Duration) -> Option<agent_desktop_core::Deadline> {
    agent_desktop_core::Deadline::from_duration(budget).ok()
}

/// The two phases apart: `prepare` runs on a worker the deadline can abandon,
/// `send` only on the calling thread and only with what `prepare` returned in
/// time.
pub(crate) fn request_via<P: Send + 'static>(
    deadline: agent_desktop_core::Deadline,
    prepare: impl FnOnce(agent_desktop_core::Deadline) -> Result<P, ActivateError> + Send + 'static,
    send: impl FnOnce(P) -> Result<(), ActivateError>,
) -> Result<(), ActivateError> {
    let prepared = bounded(deadline, Err(ActivateError::SendFailed), move || {
        prepare(deadline)
    })?;
    send(prepared)
}

/// `active_window` bounded by `budget`.
pub(crate) fn active_window_within(budget: Duration) -> Option<u32> {
    let deadline = deadline_of(budget)?;
    bounded(deadline, None, active_window)
}
