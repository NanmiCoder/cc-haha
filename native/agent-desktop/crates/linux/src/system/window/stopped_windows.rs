use std::collections::HashSet;

use agent_desktop_core::{Rect, WindowInfo, WindowState};

use super::window_id;
use crate::system::registry::Registry;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::registry::registry_app::RegistryApp;
use crate::system::x11::{FrameFacts, X11State};

/// The windows of the selected applications whose process is stopped, read
/// from the display server's client list because the applications cannot be
/// asked. Each is reported as not accessible, and its id is the application's
/// bus name with the window's X11 id, unless the window was listed before the
/// stop: then it keeps that id, so a command that names it reaches the
/// process and finds it stopped.
pub(crate) fn of_stopped_apps(
    registry: &Registry,
    select: impl Fn(&RegistryApp) -> bool,
    is_stopped: impl Fn(u32, &str) -> bool,
    state: &X11State,
    known_id: impl Fn(u32, &str) -> Option<String>,
) -> Vec<ListedWindow> {
    let X11State::Ready { clients, active } = state else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for (index, app) in registry.apps.iter().enumerate() {
        let pid = app.root.pid();
        if app.answered || !select(app) || !is_stopped(pid, &app.facts.instance) {
            continue;
        }
        for client in clients.iter().filter(|client| client.pid == Some(pid)) {
            let path = format!("/stopped/x{:x}", client.id);
            let Some(id) = known_id(client.id, &app.facts.instance)
                .or_else(|| window_id::encode(app.root.bus_name(), &path))
            else {
                continue;
            };
            if !seen.insert(client.id) {
                continue;
            }
            found.push(ListedWindow {
                app: index,
                info: WindowInfo {
                    id,
                    title: client.title.clone(),
                    app: app.name.clone(),
                    pid: pid.into(),
                    process_instance: Some(app.facts.instance.clone()),
                    bounds: client.bounds.map(Rect::from),
                    state: WindowState {
                        is_focused: false,
                        accessible: false,
                        minimized: Some(client.hidden),
                        visible: Some(!client.hidden),
                    },
                },
                active: *active == Some(client.id),
                modal: false,
                dialog: false,
                frame: FrameFacts {
                    size_identity: false,
                    pid,
                    title: client.title.clone(),
                    extents: client.bounds,
                    global_position: false,
                },
                sheet: false,
                unshown: false,
            });
        }
    }
    found
}

#[cfg(test)]
#[path = "stopped_windows_tests.rs"]
mod tests;
