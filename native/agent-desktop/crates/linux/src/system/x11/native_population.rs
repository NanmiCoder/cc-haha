use std::collections::HashSet;

use agent_desktop_core::Deadline;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, MapState, WindowClass};

use super::control::ControlRead;
use super::control_display::{atoms, longs, open, property, route};

use super::X11Client;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativePopulation {
    Complete { menus: Vec<X11Client> },
    Unproven,
}

/// Accounts for every visible native surface. Typed menu windows are kept
/// separately from managed clients; an unknown surface invalidates the read.
pub(crate) fn read(pid: u32, clients: Vec<u32>, deadline: Deadline) -> NativePopulation {
    route(deadline, move |display| {
        let read = || {
            let (connection, root) = open(&display)?;
            let managed: HashSet<_> = clients.into_iter().collect();
            for client in &managed {
                if super::resource_owner::pid(&connection, *client)? != pid {
                    return None;
                }
            }
            let names = atoms(
                &connection,
                &[
                    b"_NET_WM_WINDOW_TYPE",
                    b"_NET_WM_WINDOW_TYPE_MENU",
                    b"_NET_WM_WINDOW_TYPE_DROPDOWN_MENU",
                    b"_NET_WM_WINDOW_TYPE_POPUP_MENU",
                ],
            )?;
            let mut menus = Vec::new();
            let mut pending = vec![(root, false)];
            let mut seen = HashSet::new();
            while let Some((window, ancestor)) = pending.pop() {
                if !seen.insert(window) || seen.len() > 4_096 {
                    return None;
                }
                let mut covered = ancestor || managed.contains(&window);
                if window != root {
                    let attributes = connection
                        .get_window_attributes(window)
                        .ok()?
                        .reply()
                        .ok()?;
                    if attributes.class == WindowClass::INPUT_OUTPUT
                        && attributes.map_state == MapState::VIEWABLE
                        && super::resource_owner::pid(&connection, window)? == pid
                    {
                        if !managed.contains(&window) {
                            let kind = property(&connection, window, names[0], AtomEnum::ATOM, 8)?;
                            let kinds = longs(kind.format, &kind.value, kind.bytes_after)?;
                            if attributes.override_redirect
                                && kinds.first().is_some_and(|kind| names[1..].contains(kind))
                            {
                                menus.push(X11Client {
                                    id: window,
                                    pid: Some(pid),
                                    title: String::new(),
                                    bounds: Some(super::reader::bounds(&connection, root, window)?),
                                    extents: None,
                                    hidden: false,
                                    shadow: (0, 0, 0, 0),
                                });
                                covered = true;
                            } else if attributes.override_redirect || !covered || !kinds.is_empty()
                            {
                                return None;
                            }
                        } else if attributes.override_redirect {
                            return None;
                        }
                    }
                }
                let children = connection.query_tree(window).ok()?.reply().ok()?.children;
                pending.extend(children.into_iter().map(|child| (child, covered)));
            }
            managed.is_subset(&seen).then_some(menus)
        };
        read().map_or(ControlRead::Unavailable, ControlRead::Ready)
    })
    .ready()
    .map_or(NativePopulation::Unproven, |menus| {
        NativePopulation::Complete { menus }
    })
}
