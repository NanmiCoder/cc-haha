use super::native_group::{self, unproven};
use crate::system::process::protected::{DisplayOwner, is_helper_surface};
use crate::system::registry::listed_window;
use crate::system::x11::X11Client;
use crate::tree::Field;
use crate::tree::vocabulary::state_bits::{ACTIVE, ICONIFIED, MODAL, SHOWING, StateBits};
use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};

fn reads_x11(
    server: crate::system::display::display_server::DisplayServer,
) -> Result<bool, agent_desktop_core::AdapterError> {
    use crate::system::display::display_server::DisplayServer;
    match server {
        DisplayServer::Wayland => Ok(false),
        DisplayServer::X11(_) => Ok(true),
        DisplayServer::Unavailable(why) => Err(crate::system::display::unreachable(why)
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())),
    }
}

/// What the window listing proved about the processes that own the windows.
struct Population {
    clients: Vec<X11Client>,
    users: HashMap<u32, HashSet<u32>>,
    helper_ids: HashSet<u32>,
    complete: HashSet<u32>,
    absent: HashSet<u32>,
    windowed: HashSet<u32>,
}

/// Keeps the windows that belong to an application. A frame whose native
/// window type cannot be proven is dropped only when the window manager
/// manages no window of its process and `is_helper` proves that process a
/// helper surface of the session. Any other such frame stays listed on its
/// accessibility evidence alone: a window that cannot be classified must never
/// be hidden, and one process whose native surfaces cannot all be accounted
/// for must not refuse the listing of every other application.
fn classified(
    windows: &[listed_window::ListedWindow],
    population: &Population,
    is_helper: impl Fn(u32) -> bool,
    deadline: agent_desktop_core::Deadline,
) -> Result<Vec<listed_window::ListedWindow>, agent_desktop_core::AdapterError> {
    let mut listed = Vec::new();
    let mut proven = HashMap::new();
    let no_users = HashSet::new();
    for window in windows {
        deadline.ensure_remaining()?;
        let pid = window.frame.pid;
        if window.unshown {
            listed.push(window.clone());
            continue;
        }
        if population.absent.contains(&pid) {
            continue;
        }
        match native_group::classify(
            window,
            windows,
            &population.clients,
            population.users.get(&pid).unwrap_or(&no_users),
            &population.helper_ids,
            population.complete.contains(&pid),
        ) {
            Ok(true) => listed.push(window.clone()),
            Ok(false) => {}
            Err(_) => {
                let helper = !population.windowed.contains(&pid)
                    && *proven.entry(pid).or_insert_with(|| is_helper(pid));
                deadline.ensure_remaining()?;
                if !helper {
                    listed.push(window.clone());
                }
            }
        }
    }
    deadline.ensure_remaining()?;
    Ok(listed)
}

/// Drops the frames of the process that owns the display socket. On Wayland
/// that is the compositor, whose frames are the shell's own surfaces; every
/// other application keeps its accessibility classification. An owner that
/// cannot be proven drops nothing, so no window is hidden without proof.
fn without_owner_frames(
    windows: Vec<listed_window::ListedWindow>,
    is_owner: impl Fn(u32) -> bool,
    deadline: agent_desktop_core::Deadline,
) -> Result<Vec<listed_window::ListedWindow>, agent_desktop_core::AdapterError> {
    let pids: HashSet<u32> = windows.iter().map(|window| window.frame.pid).collect();
    let mut owners = HashSet::new();
    for pid in pids {
        deadline.ensure_remaining()?;
        if is_owner(pid) {
            owners.insert(pid);
        }
    }
    deadline.ensure_remaining()?;
    Ok(windows
        .into_iter()
        .filter(|window| !owners.contains(&window.frame.pid))
        .collect())
}

pub(in crate::system) fn without_helpers(
    windows: Vec<listed_window::ListedWindow>,
    deadline: agent_desktop_core::Deadline,
) -> Result<Vec<listed_window::ListedWindow>, agent_desktop_core::AdapterError> {
    use crate::system::display::display_server::session_server;
    use crate::system::x11::{
        DisplayReader, X11Source, X11State, control, window::window_kind::WindowKind,
    };
    deadline.ensure_remaining()?;
    if windows.iter().all(|window| window.unshown) {
        return Ok(windows);
    }
    if !reads_x11(session_server())? {
        let owner = DisplayOwner::read(deadline);
        return without_owner_frames(
            windows,
            |pid| owner.is_owner(pid).unwrap_or(false),
            deadline,
        );
    }
    let pending = crate::system::x11::start(|| DisplayReader.read());
    let read = pending.finish(deadline);
    deadline.ensure_remaining()?;
    let Some(X11State::Ready { mut clients, .. }) = read else {
        return Err(unproven(windows[0].frame.pid));
    };
    let pids: HashSet<_> = windows.iter().map(|window| window.frame.pid).collect();
    let mut user_ids = HashMap::new();
    let mut helper_ids = HashSet::new();
    let mut absent = HashSet::new();
    let mut complete = HashSet::new();
    let mut windowed = HashSet::new();
    for pid in pids {
        deadline.ensure_remaining()?;
        let managed: Vec<_> = clients
            .iter()
            .filter(|client| client.pid == Some(pid))
            .map(|client| client.id)
            .collect();
        if !managed.is_empty() {
            windowed.insert(pid);
        }
        let population =
            crate::system::x11::native_population::read(pid, managed.clone(), deadline);
        deadline.ensure_remaining()?;
        if let crate::system::x11::native_population::NativePopulation::Complete { menus } =
            population
        {
            if managed.is_empty() && menus.is_empty() {
                absent.insert(pid);
                continue;
            }
            complete.insert(pid);
            helper_ids.extend(menus.iter().map(|menu| menu.id));
            clients.extend(menus);
        }
        let native = control::toplevels_of(pid, deadline);
        deadline.ensure_remaining()?;
        let Some(native) = native.ready() else {
            return Err(unproven(pid));
        };
        let users = user_ids.entry(pid).or_insert_with(HashSet::new);
        for native in native {
            match native.kind {
                WindowKind::Normal | WindowKind::Dialog | WindowKind::Utility => {
                    users.insert(native.id);
                }
                WindowKind::Menu | WindowKind::Dock | WindowKind::Desktop => {
                    helper_ids.insert(native.id);
                }
                WindowKind::Other => {}
            }
        }
    }
    let population = Population {
        clients,
        users: user_ids,
        helper_ids,
        complete,
        absent,
        windowed,
    };
    let owner = OnceCell::new();
    classified(
        &windows,
        &population,
        |pid| {
            let owner = owner.get_or_init(|| DisplayOwner::read(deadline));
            is_helper_surface(pid, owner).unwrap_or(false)
        },
        deadline,
    )
}

/// What a frame's state set says. `None` is a state read that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FrameState {
    pub(crate) visible: Option<bool>,
    pub(crate) minimized: Option<bool>,
    pub(crate) active: Option<bool>,
    pub(crate) modal: Option<bool>,
}

pub(crate) fn frame_state(states: &Field<Vec<u32>>) -> FrameState {
    let bits = states.present().map(|words| StateBits::new(words));
    FrameState {
        visible: bits.map(|bits| bits.has(SHOWING)),
        minimized: bits.map(|bits| bits.has(ICONIFIED)),
        active: bits.map(|bits| bits.has(ACTIVE)),
        modal: bits.map(|bits| bits.has(MODAL)),
    }
}

#[cfg(test)]
#[path = "window_filter_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "window_filter_display_tests.rs"]
mod display_tests;

#[cfg(test)]
#[path = "window_filter_helper_tests.rs"]
mod helper_tests;

#[cfg(test)]
#[path = "window_filter_live_tests.rs"]
mod live_tests;

#[cfg(test)]
#[path = "window_filter_deadline_tests.rs"]
mod deadline_tests;
