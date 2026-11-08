use agent_desktop_core::Deadline;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ClientMessageEvent, ConnectionExt, EventMask, Window,
};
use x11rb::rust_connection::RustConnection;

use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::x11::control::activate::first_window;
use crate::system::x11::control::activate_error::ActivateError;
use crate::system::x11::control_display::open;
use crate::system::x11::stacking::bounded;

const NO_TIMESTAMP: u32 = 0;
const FOCUS_DEPTH: usize = 8;

fn connect() -> Result<(RustConnection, Window), ActivateError> {
    let DisplayServer::X11(display) = session_server() else {
        return Err(ActivateError::NoDisplay);
    };
    open(&display).ok_or(ActivateError::NoDisplay)
}

fn atom(connection: &RustConnection, name: &[u8]) -> Option<Atom> {
    connection
        .intern_atom(false, name)
        .ok()?
        .reply()
        .ok()
        .map(|reply| reply.atom)
}

fn send_to_root(
    window: impl FnOnce(Window) -> Window + Send + 'static,
    name: &'static [u8],
    data: [u32; 5],
    deadline: Deadline,
) -> Result<(), ActivateError> {
    bounded(deadline, Err(ActivateError::SendFailed), move || {
        let (connection, root) = connect()?;
        let kind = atom(&connection, name).ok_or(ActivateError::SendFailed)?;
        let event = ClientMessageEvent::new(32, window(root), kind, data);
        if deadline.is_expired() {
            return Err(ActivateError::SendFailed);
        }
        let mask = EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY;
        connection
            .send_event(false, root, mask, event)
            .map_err(|_| ActivateError::SendFailed)?;
        connection
            .get_input_focus()
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|_| ())
            .ok_or(ActivateError::SendFailed)
    })
}

pub(super) fn switch_desktop(desktop: u32, deadline: Deadline) -> Result<(), ActivateError> {
    send_to_root(
        |root| root,
        b"_NET_CURRENT_DESKTOP",
        [desktop, NO_TIMESTAMP, 0, 0, 0],
        deadline,
    )
}

fn title_of(connection: &RustConnection, window: Window) -> String {
    for (name, kind) in [
        (&b"_NET_WM_NAME"[..], None),
        (&b"WM_NAME"[..], Some(AtomEnum::STRING)),
    ] {
        let Some(property) = atom(connection, name) else {
            continue;
        };
        let type_ = kind.map_or_else(|| atom(connection, b"UTF8_STRING"), |k| Some(k.into()));
        let Some(type_) = type_ else { continue };
        if let Some(reply) = connection
            .get_property(false, window, property, type_, 0, 256)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            && !reply.value.is_empty()
        {
            return String::from_utf8_lossy(&reply.value).into_owned();
        }
    }
    String::new()
}

/// The title of the active window when it is a dialog transient for `client`,
/// which is what a modal dialog of the application is.
pub(super) fn dialog_over(client: u32, deadline: Deadline) -> Option<String> {
    bounded(deadline, None, move || {
        let (connection, root) = connect().ok()?;
        let active = first_window(&connection, root, atom(&connection, b"_NET_ACTIVE_WINDOW")?)?;
        if active == client {
            return None;
        }
        let owner = first_window(&connection, active, AtomEnum::WM_TRANSIENT_FOR.into())?;
        (owner == client).then(|| title_of(&connection, active))
    })
}

/// Whether the input focus lies in `client`: the focus window is the client or
/// one of its descendants.
pub(crate) fn input_focus_in(client: u32, deadline: Deadline) -> bool {
    bounded(deadline, None, move || {
        let (connection, root) = connect().ok()?;
        let mut window = connection.get_input_focus().ok()?.reply().ok()?.focus;
        for _ in 0..FOCUS_DEPTH {
            if window == client {
                return Some(true);
            }
            if window == root {
                return Some(false);
            }
            let parent = connection.query_tree(window).ok()?.reply().ok()?.parent;
            window = parent;
        }
        Some(false)
    })
    .unwrap_or(false)
}
