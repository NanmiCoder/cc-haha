use agent_desktop_core::{Deadline, ProcessIdentity};
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};

use crate::system::x11::control::ControlRead;
use crate::system::x11::control_display::{atoms, longs, open, property, route};
use crate::tree::Extents;

const STATE_LONGS: u32 = 64;

/// The window state window operations judge by readback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowFacts {
    pub(crate) client: Extents,
    pub(crate) hidden: bool,
    pub(crate) maximized_vertical: bool,
    pub(crate) maximized_horizontal: bool,
}

/// Whether `_NET_WM_STATE` carries the hidden, vertically maximized and
/// horizontally maximized atoms, in that order. An absent property carries
/// none; one of another width or cut short is unknown and never all false.
pub(in crate::system::x11) fn decode_state(
    format: u8,
    value: &[u8],
    bytes_after: u32,
    wanted: [u32; 3],
) -> Option<[bool; 3]> {
    let listed = longs(format, value, bytes_after)?;
    Some(wanted.map(|atom| listed.contains(&atom)))
}

/// The client rectangle in root coordinates and the window manager state of
/// `window`, read on a bounded thread.
pub(crate) fn read_facts(
    window: u32,
    owner: &ProcessIdentity,
    deadline: Deadline,
) -> ControlRead<WindowFacts> {
    let owner = owner.clone();
    route(deadline, move |display| {
        read_display(&display, window, &owner, deadline)
    })
}

fn read_display(
    display: &str,
    window: u32,
    owner: &ProcessIdentity,
    deadline: Deadline,
) -> ControlRead<WindowFacts> {
    let Some((connection, root)) = open(display) else {
        return ControlRead::Unavailable;
    };
    let Some(names) = atoms(
        &connection,
        &[
            b"_NET_SUPPORTING_WM_CHECK",
            b"_NET_WM_PID",
            b"_NET_WM_STATE",
            b"_NET_WM_STATE_HIDDEN",
            b"_NET_WM_STATE_MAXIMIZED_VERT",
            b"_NET_WM_STATE_MAXIMIZED_HORZ",
        ],
    ) else {
        return ControlRead::Unavailable;
    };
    let [check, pid_atom, state, hidden, vertical, horizontal] = names.as_slice() else {
        return ControlRead::Unavailable;
    };
    let Some(manager) = property(&connection, root, *check, AtomEnum::WINDOW, 1) else {
        return ControlRead::Unavailable;
    };
    if manager.value.is_empty() {
        return ControlRead::NoManager;
    }
    super::control_owner::with_owner(
        owner,
        || super::control_grab::ServerGrab::acquire(&connection, deadline),
        || crate::system::x11::control::pid_of(&connection, window, *pid_atom),
        crate::system::process::liveness::identity,
        || {
            Ok(read_current(
                &connection,
                root,
                window,
                [*state, *hidden, *vertical, *horizontal],
            ))
        },
    )
    .unwrap_or(ControlRead::Unavailable)
}

fn read_current(
    connection: &x11rb::rust_connection::RustConnection,
    root: u32,
    window: u32,
    names: [u32; 4],
) -> ControlRead<WindowFacts> {
    let [state, hidden, vertical, horizontal] = names;
    let pending = (
        connection.get_property(false, window, state, AtomEnum::ATOM, 0, STATE_LONGS),
        connection.translate_coordinates(window, root, 0, 0),
        connection.get_geometry(window),
    );
    let (Ok(state_cookie), Ok(origin_cookie), Ok(size_cookie)) = pending else {
        return ControlRead::Unavailable;
    };
    let (Ok(state_reply), Ok(origin), Ok(size)) = (
        state_cookie.reply(),
        origin_cookie.reply(),
        size_cookie.reply(),
    ) else {
        return ControlRead::Unavailable;
    };
    let Some([is_hidden, is_vertical, is_horizontal]) = decode_state(
        state_reply.format,
        &state_reply.value,
        state_reply.bytes_after,
        [hidden, vertical, horizontal],
    ) else {
        return ControlRead::Unavailable;
    };
    ControlRead::Ready(WindowFacts {
        client: Extents {
            x: i32::from(origin.dst_x),
            y: i32::from(origin.dst_y),
            width: i32::from(size.width),
            height: i32::from(size.height),
        },
        hidden: is_hidden,
        maximized_vertical: is_vertical,
        maximized_horizontal: is_horizontal,
    })
}

#[cfg(test)]
#[path = "window_facts_tests.rs"]
mod tests;
