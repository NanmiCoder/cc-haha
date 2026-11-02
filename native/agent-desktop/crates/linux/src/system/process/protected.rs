use std::cell::OnceCell;
use std::collections::HashSet;
use std::path::PathBuf;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};

use crate::system::bus::bus_process::owner_process_id;
use crate::system::bus::session_bus::SessionBus;
use crate::system::display::display_env::DisplayEnv;
use crate::system::display::display_server::{DisplayServer, session_server};
use crate::system::process::process_facts;
use crate::system::process::process_lookup::Lookup;
use crate::system::process::session_origin;
use crate::system::registry::Registry;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::window::window_ops::windows_of;

fn unknown() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The session process ownership could not be proven",
    )
    .with_disposition(DeliverySemantics::not_delivered())
    .with_suggestion(
        "Run inside the target desktop session with readable process and session-bus ownership.",
    )
}

fn socket_of(server: DisplayServer) -> Result<PathBuf, AdapterError> {
    match server {
        DisplayServer::Wayland => {
            let env = DisplayEnv::from_process();
            let name = env.wayland.ok_or_else(unknown)?;
            let path = PathBuf::from(name);
            if path.is_absolute() {
                Ok(path)
            } else {
                Ok(env.runtime_dir.ok_or_else(unknown)?.join(path))
            }
        }
        DisplayServer::X11(display) => {
            let number = display.strip_prefix(':').ok_or_else(unknown)?;
            let number = number.split('.').next().ok_or_else(unknown)?;
            if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(unknown());
            }
            Ok(PathBuf::from(format!("/tmp/.X11-unix/X{number}")))
        }
        DisplayServer::Unavailable(why) => Err(crate::system::display::unreachable(why)
            .with_disposition(DeliverySemantics::not_delivered())),
    }
}

fn listening_inodes(socket: &std::path::Path) -> Result<HashSet<String>, AdapterError> {
    let table = std::fs::read_to_string("/proc/net/unix").map_err(|_| unknown())?;
    let path = socket.to_str().ok_or_else(unknown)?;
    let abstract_path = format!("@{path}");
    let inodes: HashSet<String> = table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let words: Vec<_> = line.split_whitespace().collect();
            let bound = words.get(7..)?.join(" ");
            let flags = u32::from_str_radix(words.get(3)?, 16).ok()?;
            ((bound == path || bound == abstract_path) && flags & 0x0001_0000 != 0)
                .then(|| format!("socket:[{}]", words[6]))
        })
        .collect();
    if inodes.is_empty() {
        return Err(unknown());
    }
    Ok(inodes)
}

fn holds_any(pid: u32, inodes: &HashSet<String>) -> Result<bool, AdapterError> {
    let fds = std::fs::read_dir(format!("/proc/{pid}/fd")).map_err(|_| unknown())?;
    for fd in fds {
        let fd = fd.map_err(|_| unknown())?;
        match std::fs::read_link(fd.path()) {
            Ok(link) if inodes.contains(link.to_string_lossy().as_ref()) => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(unknown()),
        }
    }
    Ok(false)
}

#[cfg(test)]
fn owns_socket(pid: u32, socket: &std::path::Path) -> Result<bool, AdapterError> {
    holds_any(pid, &listening_inodes(socket)?)
}

/// What names the display server's owner, read once and then asked about any
/// number of processes: the listeners of the display socket and, on X11, the
/// owner of the window manager's supporting window.
pub(in crate::system) struct DisplayOwner {
    sockets: Result<HashSet<String>, AdapterError>,
    x11: bool,
    manager: OnceCell<Result<Option<u32>, AdapterError>>,
    deadline: Deadline,
}

impl DisplayOwner {
    pub(in crate::system) fn read(deadline: Deadline) -> Self {
        let server = session_server();
        let x11 = matches!(server, DisplayServer::X11(_));
        Self {
            sockets: socket_of(server).and_then(|socket| listening_inodes(&socket)),
            x11,
            manager: OnceCell::new(),
            deadline,
        }
    }

    pub(in crate::system) fn is_owner(&self, pid: u32) -> Result<bool, AdapterError> {
        let inodes = self.sockets.as_ref().map_err(Clone::clone)?;
        if holds_any(pid, inodes)? {
            return Ok(true);
        }
        if !self.x11 {
            return Ok(false);
        }
        match self.manager.get_or_init(|| manager_owner(self.deadline)) {
            Ok(owner) => Ok(*owner == Some(pid)),
            Err(error) => Err(error.clone()),
        }
    }
}

fn manager_owner(deadline: Deadline) -> Result<Option<u32>, AdapterError> {
    crate::system::x11::control::manager_pid(deadline)
        .ready()
        .ok_or_else(|| {
            unknown().with_platform_detail("The X root supporting-WM resource owner is unavailable")
        })
}

pub(in crate::system) fn is_display_owner(
    pid: u32,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    DisplayOwner::read(deadline).is_owner(pid)
}

async fn service_owner(pid: u32, connection: &zbus::Connection) -> Result<bool, AdapterError> {
    let reply = connection
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "ListNames",
            &(),
        )
        .await
        .map_err(|_| unknown())?;
    let names = reply
        .body()
        .deserialize::<Vec<String>>()
        .map_err(|_| unknown())?;
    for name in names.iter().filter(|name| !name.starts_with(':')) {
        match owner_process_id(connection, name).await {
            Ok(owner) if owner == pid => return Ok(true),
            Ok(_) => {}
            Err(zbus::Error::MethodError(name, _, _))
                if name.as_str() == "org.freedesktop.DBus.Error.NameHasNoOwner" => {}
            Err(_) => return Err(unknown()),
        }
    }
    Ok(false)
}

fn has_managed_window(pid: u32, deadline: Deadline) -> bool {
    crate::system::x11::control::toplevels_of(pid, deadline)
        .ready()
        .is_some_and(|windows| !windows.is_empty())
}

/// Whether a process shows a window: the window manager manages one for it
/// or, where it manages none, its accessibility tree lists one that is shown
/// or iconified. A native Wayland window is in the tree only, and a husk that
/// a toolkit keeps after a window closed is not a window. A tree that cannot
/// be read shows none.
fn shows_a_window(
    managed: impl FnOnce() -> bool,
    listed: impl FnOnce() -> Result<Vec<ListedWindow>, AdapterError>,
) -> bool {
    managed() || listed().is_ok_and(|windows| windows.iter().any(|window| !window.unshown))
}

fn answering_app_is_session_service(
    bus: &crate::system::SharedBus,
    registry: &Registry,
    pid: u32,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    session_origin::is_session_service(
        || session_origin::launched_by_agent(pid),
        || {
            shows_a_window(
                || has_managed_window(pid, deadline),
                || windows_of(bus, registry, |app| app.root.pid() == pid, deadline),
            )
        },
        || session_origin::runs_as_service(pid),
        || session_origin::child_of_display_owner(pid, |parent| is_display_owner(parent, deadline)),
        || owns_session_bus_name(pid, deadline),
    )
}

/// Whether a process that does not answer on the accessibility bus is a
/// session service: it owns a name on the session bus and the window manager
/// manages no window of it. One that a launch of this tool started never is,
/// whatever name it owns. A hung application keeps its windows and every
/// unique application owns a name, so a managed window shows an application
/// and not a service. A window read that fails clears nothing, and any other
/// fact that cannot be read refuses.
fn silent_app_is_session_service(
    launched: impl FnOnce() -> Result<bool, AdapterError>,
    windowed: impl FnOnce() -> bool,
    named: impl FnOnce() -> Result<bool, AdapterError>,
) -> Result<bool, AdapterError> {
    session_origin::is_session_service(launched, windowed, || Ok(false), || Ok(false), named)
}

/// Whether a process whose window frames the listing cannot classify is a
/// helper surface of the session itself, the compositor or a decoration frame
/// it hosts. The caller has proven the process has no managed window. One
/// that a launch of this tool started never is, and one the session did not
/// start is not proven to be. A fact that cannot be read proves nothing.
pub(in crate::system) fn is_helper_surface(
    pid: u32,
    owner: &DisplayOwner,
) -> Result<bool, AdapterError> {
    session_origin::is_session_service(
        || session_origin::launched_by_agent(pid),
        || false,
        || session_origin::runs_as_service(pid),
        || session_origin::on_display_owner_side(pid, |candidate| owner.is_owner(candidate)),
        || Ok(false),
    )
}

fn owns_session_bus_name(pid: u32, deadline: Deadline) -> Result<bool, AdapterError> {
    let connection = SessionBus::get(deadline)
        .map_err(|error| unknown().with_platform_detail(error.to_string()))?;
    crate::system::within(deadline, async { service_owner(pid, &connection).await })
        .map_err(|error| error.with_disposition(DeliverySemantics::not_delivered()))
}

pub(crate) fn is_protected(
    bus: &crate::system::SharedBus,
    pid: u32,
    instance: &str,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let instance_matches =
        || matches!(process_facts::lookup(pid), Lookup::Found(facts) if facts.instance == instance);
    if !instance_matches() {
        return Err(unknown());
    }
    let display_owner = is_display_owner(pid, deadline)?;
    if !instance_matches() {
        return Err(unknown());
    }
    if display_owner {
        return Ok(true);
    }
    let registry = crate::system::registry::read_registry_for(bus, Some(pid), deadline)
        .map_err(|error| unknown().with_platform_detail(error.to_string()))?;
    if !instance_matches() {
        return Err(unknown());
    }
    if registry
        .apps
        .iter()
        .any(|app| app.root.pid() == pid && app.answered)
    {
        let session_started = answering_app_is_session_service(bus, &registry, pid, deadline)?;
        if !instance_matches() {
            return Err(unknown());
        }
        return Ok(session_started);
    }
    let owner = silent_app_is_session_service(
        || session_origin::launched_by_agent(pid),
        || has_managed_window(pid, deadline),
        || owns_session_bus_name(pid, deadline),
    )?;
    if !instance_matches() {
        return Err(unknown());
    }
    Ok(owner)
}

#[cfg(test)]
#[path = "protected_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "protected_live_tests.rs"]
mod live_tests;
