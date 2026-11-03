use crate::system::x11::control::control_error::ControlError;
use crate::system::x11::window::toplevel::Toplevel;
use agent_desktop_core::Deadline;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};
use x11rb::rust_connection::RustConnection;

use super::X11Client;
use super::control::control_send::close_window;
use super::control_display::{atoms, longs, open, property, route};
use super::snapshot::{decode_frame_extents, decode_shadow, decode_title};
use super::stacking::stacking_atoms::names;
use super::stacking::stacking_decode::decode_kind;
use super::window::window_kind::WindowKind;

const MAX_TOPLEVELS: u32 = 4_096;
const MAX_NAME_LONGS: u32 = 1_024;

/// The answer of a bounded read of the display server for window control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ControlRead<T> {
    Ready(T),
    NotX11,
    NoManager,
    Unavailable,
}

impl<T> ControlRead<T> {
    /// The answer when there is one; every other state is no answer.
    pub(crate) fn ready(self) -> Option<T> {
        match self {
            Self::Ready(value) => Some(value),
            Self::NotX11 | Self::NoManager | Self::Unavailable => None,
        }
    }
}

/// The managed top-level windows whose `_NET_WM_PID` is `pid`, dialogs
/// included.
pub(crate) fn toplevels_of(pid: u32, deadline: Deadline) -> ControlRead<Vec<Toplevel>> {
    route(deadline, move |display| read_toplevels(&display, pid))
}

/// Asks the window manager to close one window.
pub(crate) fn request_close(
    window: u32,
    pid: u32,
    instance: &str,
    deadline: Deadline,
) -> Result<(), ControlError> {
    close_window(window, pid, instance, deadline)
}

/// The name the running window manager gives itself, read from the window
/// `_NET_SUPPORTING_WM_CHECK` names.
pub(crate) fn manager_name(deadline: Deadline) -> Option<String> {
    route(deadline, |display| {
        read_manager_name(&display).map_or(ControlRead::Unavailable, ControlRead::Ready)
    })
    .ready()
}

fn read_manager_name(display: &str) -> Option<String> {
    let (connection, root) = open(display)?;
    let named = atoms(
        &connection,
        &[b"_NET_SUPPORTING_WM_CHECK", b"_NET_WM_NAME", b"UTF8_STRING"],
    )?;
    let [check, name, utf8] = named.as_slice() else {
        return None;
    };
    let reply = property(&connection, root, *check, AtomEnum::WINDOW, 1)?;
    let manager = *longs(reply.format, &reply.value, reply.bytes_after)?.first()?;
    let title = property(&connection, manager, *name, *utf8, MAX_NAME_LONGS)?;
    let text = String::from_utf8_lossy(&title.value).into_owned();
    Some(text).filter(|text| !text.is_empty())
}

pub(crate) fn manager_pid(deadline: Deadline) -> ControlRead<Option<u32>> {
    route(deadline, |display| {
        let read = || {
            let (connection, root) = open(&display)?;
            let names = atoms(&connection, &[b"_NET_SUPPORTING_WM_CHECK"])?;
            let check = |window| {
                let reply = property(&connection, window, names[0], AtomEnum::WINDOW, 1)?;
                longs(reply.format, &reply.value, reply.bytes_after)
            };
            let managers = check(root)?;
            let Some(&manager) = managers.first() else {
                return Some(None);
            };
            if check(manager)?.as_slice() != [manager] {
                return None;
            }
            super::resource_owner::pid(&connection, manager).map(Some)
        };
        read().map_or(ControlRead::Unavailable, ControlRead::Ready)
    })
}

/// The managed clients of an Xwayland display, as the window listing reads
/// them from an X11 session.
pub(crate) fn xwayland_clients(deadline: Deadline) -> ControlRead<Vec<X11Client>> {
    route(deadline, |display| read_clients(&display))
}

fn read_clients(display: &str) -> ControlRead<Vec<X11Client>> {
    let Some((connection, root)) = open(display) else {
        return ControlRead::Unavailable;
    };
    let Some(got) = atoms(
        &connection,
        &[
            b"_NET_SUPPORTING_WM_CHECK",
            b"_NET_CLIENT_LIST",
            b"_NET_WM_PID",
            b"_NET_WM_NAME",
            b"UTF8_STRING",
            b"_NET_FRAME_EXTENTS",
            b"_NET_WM_STATE",
            b"_NET_WM_STATE_HIDDEN",
            b"_GTK_FRAME_EXTENTS",
        ],
    ) else {
        return ControlRead::Unavailable;
    };
    let [check, list, pid, name, utf8, frame, state, hidden, gtk] = got.as_slice() else {
        return ControlRead::Unavailable;
    };
    match property(&connection, root, *check, AtomEnum::WINDOW, 1) {
        Some(manager) if !manager.value.is_empty() => {}
        Some(_) => return ControlRead::NoManager,
        None => return ControlRead::Unavailable,
    }
    let Some(listed) = property(&connection, root, *list, AtomEnum::WINDOW, MAX_TOPLEVELS)
        .and_then(|reply| longs(reply.format, &reply.value, reply.bytes_after))
    else {
        return ControlRead::Unavailable;
    };
    let clients = listed
        .into_iter()
        .map(|window| {
            let pid = pid_of(&connection, window, *pid);
            let extents = property(&connection, window, *frame, AtomEnum::CARDINAL, 4)
                .and_then(|reply| decode_frame_extents(reply.format, &reply.value));
            let is_hidden = property(&connection, window, *state, AtomEnum::ATOM, 64)
                .and_then(|reply| longs(reply.format, &reply.value, reply.bytes_after))
                .is_some_and(|atoms| atoms.contains(hidden));
            let shadow = property(&connection, window, *gtk, AtomEnum::CARDINAL, 4)
                .map_or((0, 0, 0, 0), |reply| {
                    decode_shadow(reply.format, &reply.value)
                });
            X11Client {
                id: window,
                shadow,
                pid,
                title: title_of(&connection, window, *name, *utf8),
                extents,
                bounds: super::reader::bounds(&connection, root, window),
                hidden: is_hidden,
            }
        })
        .collect();
    ControlRead::Ready(clients)
}

fn title_of(connection: &RustConnection, window: u32, name: u32, utf8: u32) -> String {
    let wide = property(connection, window, name, utf8, MAX_NAME_LONGS);
    let narrow = property(
        connection,
        window,
        AtomEnum::WM_NAME.into(),
        AtomEnum::STRING,
        MAX_NAME_LONGS,
    );
    decode_title(
        wide.as_ref()
            .map(|reply| (reply.format, reply.value.as_slice())),
        narrow
            .as_ref()
            .map(|reply| (reply.format, reply.value.as_slice())),
    )
}

pub(super) fn pid_of(connection: &RustConnection, window: u32, pid_atom: u32) -> Option<u32> {
    property(connection, window, pid_atom, AtomEnum::CARDINAL, 1)
        .and_then(|reply| longs(reply.format, &reply.value, reply.bytes_after))
        .and_then(|values| values.first().copied())
}

fn pid_matches(connection: &RustConnection, window: u32, pid_atom: u32, pid: u32) -> bool {
    pid_of(connection, window, pid_atom) == Some(pid)
}

fn read_toplevels(display: &str, pid: u32) -> ControlRead<Vec<Toplevel>> {
    let Some((connection, root)) = open(display) else {
        return ControlRead::Unavailable;
    };
    let Some(known) = names(&connection) else {
        return ControlRead::Unavailable;
    };
    let Some([pid_atom, name_atom, utf8_atom]) = atoms(
        &connection,
        &[b"_NET_WM_PID", b"_NET_WM_NAME", b"UTF8_STRING"],
    )
    .and_then(|got| <[u32; 3]>::try_from(got).ok()) else {
        return ControlRead::Unavailable;
    };
    let Some(manager) = property(&connection, root, known.root.wm_check, AtomEnum::WINDOW, 1)
    else {
        return ControlRead::Unavailable;
    };
    if manager.value.is_empty() {
        return ControlRead::NoManager;
    }
    let Some(listed) = property(
        &connection,
        root,
        known.root.stacking,
        AtomEnum::WINDOW,
        MAX_TOPLEVELS,
    )
    .and_then(|reply| longs(reply.format, &reply.value, reply.bytes_after)) else {
        return ControlRead::Unavailable;
    };
    let mut found = Vec::new();
    for window in listed
        .into_iter()
        .filter(|window| pid_matches(&connection, *window, pid_atom, pid))
    {
        let Some(reply) = property(&connection, window, known.window.kind, AtomEnum::ATOM, 8)
        else {
            return ControlRead::Unavailable;
        };
        if longs(reply.format, &reply.value, reply.bytes_after).is_none() {
            return ControlRead::Unavailable;
        }
        let kind = decode_kind(reply.format, &reply.value, known.window.types);
        let transient = connection
            .get_property(
                false,
                window,
                AtomEnum::WM_TRANSIENT_FOR,
                AtomEnum::WINDOW,
                0,
                1,
            )
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_some_and(|reply| !reply.value.is_empty());
        let title = if transient || kind == WindowKind::Dialog {
            title_of(&connection, window, name_atom, utf8_atom)
        } else {
            String::new()
        };
        found.push(Toplevel {
            id: window,
            title,
            kind,
            transient,
        });
    }
    ControlRead::Ready(found)
}

pub(crate) mod activate;
pub(crate) mod activate_error;
pub(crate) mod client_message;
pub(crate) mod control_error;
pub(super) mod control_grab;
pub(super) mod control_owner;
pub(crate) mod control_send;
#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
pub(crate) mod window_facts;
