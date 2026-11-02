use x11rb::connection::Connection;
use x11rb::protocol::xproto::{Atom, AtomEnum, ConnectionExt, GetPropertyReply, MapState, Window};
use x11rb::rust_connection::RustConnection;

use super::control_display::property;
use super::snapshot::{decode_cardinals, decode_frame_extents, decode_shadow, decode_title};
use super::stacking::stacking_read::StackingRead;
use super::stacking::{bounded, capped, route};
use super::window::popup_window::PopupWindow;
use super::{X11Client, X11Source, X11State};
use crate::system::display::display_server::{DisplayServer, session_server};
use crate::tree::Extents;
use agent_desktop_core::Deadline;

const MAX_CLIENTS: usize = 256;
const MAX_LIST_LONGS: u32 = 4_096;
const MAX_TITLE_LONGS: u32 = 1_024;
const STATE_LONGS: u32 = 64;

/// Reads window-manager properties from the display named by `DISPLAY`. It
/// connects on every read and keeps nothing: a connection kept between calls
/// would outlive a server that has stopped answering.
pub(crate) struct DisplayReader;

impl DisplayReader {
    pub(crate) fn connect(
        display: &str,
    ) -> Result<(RustConnection, usize), x11rb::errors::ConnectError> {
        super::bounded::connect(display)
    }

    pub(crate) fn reachable(display: &str) -> Result<(), super::MonitorFault> {
        let (connection, _) =
            Self::connect(display).map_err(|error| super::fault_of_connect(&error))?;
        connection
            .get_input_focus()
            .map_err(|_| super::MonitorFault::Unreadable)?
            .reply()
            .map_err(|_| super::MonitorFault::Unreadable)?;
        Ok(())
    }
}

impl super::stacking::stacking_source::StackingSource for DisplayReader {
    fn read_within(&self, target_client: u32, caller: Deadline) -> StackingRead {
        route(session_server(), |display| {
            let Some(deadline) = capped(caller) else {
                return StackingRead::Unavailable;
            };
            bounded(deadline, StackingRead::Unavailable, move || {
                super::stacking::stacking_wire::read_stacking(&display, target_client)
            })
        })
    }

    fn clients_within(&self, caller: Deadline) -> X11State {
        let Some(deadline) = capped(caller) else {
            return X11State::Unavailable;
        };
        bounded(deadline, X11State::Unavailable, || X11Source::read(&Self))
    }
}

impl DisplayReader {
    pub(crate) fn popup_origin(pid: u32, size: (i32, i32), caller: Deadline) -> Option<(i32, i32)> {
        Self::popup_window(pid, size, caller).map(|window| (window.bounds.x, window.bounds.y))
    }

    pub(crate) fn popup_window(
        pid: u32,
        size: (i32, i32),
        caller: Deadline,
    ) -> Option<PopupWindow> {
        let deadline = capped(caller)?;
        match session_server() {
            DisplayServer::X11(display) => bounded(deadline, None, move || {
                read_popup_window(&display, pid, size)
            }),
            DisplayServer::Wayland | DisplayServer::Unavailable(_) => None,
        }
    }
}

fn read_popup_window(display: &str, pid: u32, size: (i32, i32)) -> Option<PopupWindow> {
    let popups = read_popup_windows(display, pid)?;
    unique_popup(
        &popups
            .into_iter()
            .filter(|popup| (popup.bounds.width, popup.bounds.height) == size)
            .collect::<Vec<_>>(),
    )
}

fn read_popup_windows(display: &str, pid: u32) -> Option<Vec<PopupWindow>> {
    let (connection, screen) = DisplayReader::connect(display).ok()?;
    let root = connection.setup().roots.get(screen)?.root;
    let pid_atom = atom(&connection, b"_NET_WM_PID")?;
    let windows = connection.query_tree(root).ok()?.reply().ok()?.children;
    let mut popups = Vec::new();
    for window in windows {
        let attributes = connection
            .get_window_attributes(window)
            .ok()?
            .reply()
            .ok()?;
        if !attributes.override_redirect || attributes.map_state != MapState::VIEWABLE {
            continue;
        }
        let owner = cardinals(property(
            &connection,
            window,
            pid_atom,
            AtomEnum::CARDINAL,
            1,
        ))
        .and_then(|values| values.first().copied());
        let geometry = connection.get_geometry(window).ok()?.reply().ok()?;
        let rect = Extents {
            x: 0,
            y: 0,
            width: i32::from(geometry.width),
            height: i32::from(geometry.height),
        };
        if owner != Some(pid) {
            continue;
        }
        let origin = connection
            .translate_coordinates(window, root, 0, 0)
            .ok()?
            .reply()
            .ok()?;
        popups.push(PopupWindow {
            id: window,
            bounds: Extents {
                x: i32::from(origin.dst_x),
                y: i32::from(origin.dst_y),
                ..rect
            },
        });
    }
    Some(popups)
}

fn unique_popup(popups: &[PopupWindow]) -> Option<PopupWindow> {
    (popups.len() == 1).then(|| popups[0])
}

impl DisplayReader {
    pub(crate) fn popup_at(pid: u32, point: (i32, i32), caller: Deadline) -> Option<PopupWindow> {
        let deadline = capped(caller)?;
        let DisplayServer::X11(display) = session_server() else {
            return None;
        };
        bounded(deadline, None, move || {
            unique_popup(
                &read_popup_windows(&display, pid)?
                    .into_iter()
                    .filter(|popup| crate::tree::hit_test::hit_guard::admits(popup.bounds, point))
                    .collect::<Vec<_>>(),
            )
        })
    }

    pub(crate) fn popup_containing(
        pid: u32,
        screen: Extents,
        window: Extents,
        caller: Deadline,
    ) -> Option<PopupWindow> {
        let deadline = capped(caller)?;
        let DisplayServer::X11(display) = session_server() else {
            return None;
        };
        bounded(deadline, None, move || {
            matching_popup(&read_popup_windows(&display, pid)?, screen, window)
        })
    }
}

fn matching_popup(popups: &[PopupWindow], screen: Extents, window: Extents) -> Option<PopupWindow> {
    let matching = popups
        .iter()
        .copied()
        .filter(|popup| {
            crate::tree::placement::frame_geometry::origins_agree(
                screen,
                window,
                (popup.bounds.x, popup.bounds.y),
            ) && crate::tree::hit_test::hit_guard::aimable(screen)
                && crate::tree::hit_test::hit_guard::aimable(window)
                && (screen.width, screen.height) == (window.width, window.height)
                && window.x >= 0
                && window.y >= 0
                && i64::from(window.x) + i64::from(window.width) <= i64::from(popup.bounds.width)
                && i64::from(window.y) + i64::from(window.height) <= i64::from(popup.bounds.height)
        })
        .collect::<Vec<_>>();
    unique_popup(&matching)
}

#[cfg(test)]
#[path = "popup_reader_tests.rs"]
mod popup_tests;

struct Atoms {
    wm_check: Atom,
    active: Atom,
    client_list: Atom,
    pid: Atom,
    name: Atom,
    utf8: Atom,
    frame_extents: Atom,
    gtk_extents: Atom,
    state: Atom,
    hidden: Atom,
}

fn display_to_read() -> Option<String> {
    match crate::system::display::display_server::session_server() {
        crate::system::display::display_server::DisplayServer::X11(display) => Some(display),
        _ => None,
    }
}

fn atom(connection: &RustConnection, name: &[u8]) -> Option<Atom> {
    Some(connection.intern_atom(false, name).ok()?.reply().ok()?.atom)
}

fn atoms(connection: &RustConnection) -> Option<Atoms> {
    Some(Atoms {
        wm_check: atom(connection, b"_NET_SUPPORTING_WM_CHECK")?,
        active: atom(connection, b"_NET_ACTIVE_WINDOW")?,
        client_list: atom(connection, b"_NET_CLIENT_LIST")?,
        pid: atom(connection, b"_NET_WM_PID")?,
        name: atom(connection, b"_NET_WM_NAME")?,
        utf8: atom(connection, b"UTF8_STRING")?,
        frame_extents: atom(connection, b"_NET_FRAME_EXTENTS")?,
        gtk_extents: atom(connection, b"_GTK_FRAME_EXTENTS")?,
        state: atom(connection, b"_NET_WM_STATE")?,
        hidden: atom(connection, b"_NET_WM_STATE_HIDDEN")?,
    })
}

fn cardinals(reply: Option<GetPropertyReply>) -> Option<Vec<u32>> {
    let reply = reply?;
    decode_cardinals(reply.format, &reply.value)
}

pub(super) fn bounds(connection: &RustConnection, root: Window, window: Window) -> Option<Extents> {
    let origin = connection
        .translate_coordinates(window, root, 0, 0)
        .ok()?
        .reply()
        .ok()?;
    let size = connection.get_geometry(window).ok()?.reply().ok()?;
    Some(Extents {
        x: i32::from(origin.dst_x),
        y: i32::from(origin.dst_y),
        width: i32::from(size.width),
        height: i32::from(size.height),
    })
}

fn client(connection: &RustConnection, atoms: &Atoms, root: Window, window: Window) -> X11Client {
    let pid = cardinals(property(
        connection,
        window,
        atoms.pid,
        AtomEnum::CARDINAL,
        1,
    ))
    .and_then(|values| values.first().copied());
    let wide = property(connection, window, atoms.name, atoms.utf8, MAX_TITLE_LONGS);
    let narrow = property(
        connection,
        window,
        AtomEnum::WM_NAME.into(),
        AtomEnum::STRING,
        MAX_TITLE_LONGS,
    );
    let extents = property(
        connection,
        window,
        atoms.frame_extents,
        AtomEnum::CARDINAL,
        4,
    )
    .and_then(|reply| decode_frame_extents(reply.format, &reply.value));
    let shadow = property(connection, window, atoms.gtk_extents, AtomEnum::CARDINAL, 4)
        .map_or((0, 0, 0, 0), |reply| {
            decode_shadow(reply.format, &reply.value)
        });
    let hidden = cardinals(property(
        connection,
        window,
        atoms.state,
        AtomEnum::ATOM,
        STATE_LONGS,
    ))
    .is_some_and(|states| states.contains(&atoms.hidden));
    X11Client {
        id: window,
        pid,
        title: decode_title(
            wide.as_ref()
                .map(|reply| (reply.format, reply.value.as_slice())),
            narrow
                .as_ref()
                .map(|reply| (reply.format, reply.value.as_slice())),
        ),
        extents,
        bounds: bounds(connection, root, window),
        hidden,
        shadow,
    }
}

fn read_display(display: &str) -> X11State {
    let Ok((connection, screen)) = super::bounded::connect(display) else {
        return X11State::Unavailable;
    };
    let Some(root) = connection
        .setup()
        .roots
        .get(screen)
        .map(|screen| screen.root)
    else {
        return X11State::Unavailable;
    };
    let Some(atoms) = atoms(&connection) else {
        return X11State::Unavailable;
    };
    let manager = cardinals(property(
        &connection,
        root,
        atoms.wm_check,
        AtomEnum::WINDOW,
        1,
    ));
    if manager.is_none_or(|values| values.is_empty()) {
        return X11State::NoWindowManager;
    }
    let active = cardinals(property(
        &connection,
        root,
        atoms.active,
        AtomEnum::WINDOW,
        1,
    ))
    .and_then(|values| values.first().copied())
    .filter(|window| *window != 0);
    let Some(listed) = cardinals(property(
        &connection,
        root,
        atoms.client_list,
        AtomEnum::WINDOW,
        MAX_LIST_LONGS,
    )) else {
        return X11State::Unavailable;
    };
    let clients = listed
        .into_iter()
        .take(MAX_CLIENTS)
        .map(|window| client(&connection, &atoms, root, window))
        .collect();
    X11State::Ready { active, clients }
}

impl X11Source for DisplayReader {
    fn read(&self) -> X11State {
        display_to_read().map_or(X11State::Unavailable, |display| read_display(&display))
    }
}
