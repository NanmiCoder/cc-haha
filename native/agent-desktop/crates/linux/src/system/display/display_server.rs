use crate::system::display::display_cause::Cause;
use crate::system::display::display_env::DisplayEnv;
use crate::system::display::display_reach::Reach;
use crate::system::display::display_unavailable::Unavailable;
use std::path::{Path, PathBuf};

pub(crate) use super::display_error::{DisplayCause, display_cause_error};
pub(crate) use crate::system::display::fault_error;

/// Which display server this session's reads may reach. A configured server
/// is only chosen when its endpoint answers, so a `WAYLAND_DISPLAY` left over
/// from another session falls through to a working `DISPLAY`. A reachable
/// Wayland server decides before X11 because an Xwayland client still lives
/// on a Wayland desktop whose windows X11 calls cannot enumerate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DisplayServer {
    Wayland,
    X11(String),
    Unavailable(Unavailable),
}

/// How an endpoint is tried.
pub(crate) trait Probe {
    fn wayland(&self, socket: &Path) -> Reach;
    fn x11(&self, display: &str) -> Reach;
}

fn wayland_socket(env: &DisplayEnv, name: &str) -> Option<PathBuf> {
    if name.starts_with('/') {
        return Some(PathBuf::from(name));
    }
    env.runtime_dir.as_ref().map(|dir| dir.join(name))
}

fn failure(variable: &str, value: &str, reach: Reach) -> (Cause, String) {
    match reach {
        Reach::Missing => (
            Cause::Missing,
            format!("{variable}={value} names a server that is not running"),
        ),
        _ => (
            Cause::Refused,
            format!("{variable}={value} refused the connection"),
        ),
    }
}

/// The display name every reader is given. A local name written with the
/// `unix` transport prefix (`unix:1`) is the same display as `:1`, but the
/// readers' connection parser takes `unix` for a host name, so the name is
/// handed over without the prefix.
pub(crate) fn canonical_display(display: &str) -> String {
    match display.strip_prefix("unix") {
        Some(rest) if rest.starts_with(':') => rest.to_owned(),
        _ => display.to_owned(),
    }
}

/// Chooses the display server from the environment and what answers.
pub(crate) fn detect(env: &DisplayEnv, probe: &dyn Probe) -> DisplayServer {
    let mut failures = Vec::new();
    if let Some(name) = &env.wayland {
        let reach =
            wayland_socket(env, name).map_or(Reach::Missing, |socket| probe.wayland(&socket));
        if reach == Reach::Connected {
            return DisplayServer::Wayland;
        }
        failures.push(failure("WAYLAND_DISPLAY", name, reach));
    }
    if let Some(display) = &env.display {
        let reach = probe.x11(display);
        if reach == Reach::Connected {
            return DisplayServer::X11(canonical_display(display));
        }
        failures.push(failure("DISPLAY", display, reach));
    }
    let cause = if failures.is_empty() {
        Cause::NotConfigured
    } else if failures.iter().any(|(cause, _)| *cause == Cause::Refused) {
        Cause::Refused
    } else {
        Cause::Missing
    };
    let detail = failures
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("; ");
    DisplayServer::Unavailable(Unavailable { cause, detail })
}

/// The display server this process's environment reaches right now.
pub(crate) fn session_server() -> DisplayServer {
    detect(
        &DisplayEnv::from_process(),
        &super::display_probe::SocketProbe,
    )
}

/// Proves the selected X11 server completed its handshake and answered a
/// read before an operation depends on its window or input evidence.
pub(crate) fn require(
    deadline: agent_desktop_core::Deadline,
) -> Result<super::route::Route, agent_desktop_core::AdapterError> {
    let route = super::route::current()?;
    if let super::route::Route::X11(display) = &route {
        let name = display.clone();
        let pending =
            crate::system::x11::start(move || crate::system::x11::DisplayReader::reachable(&name));
        match pending.finish(deadline) {
            Some(Ok(_)) => {}
            Some(Err(fault)) => return Err(fault_error(display, Some(fault))),
            None => return Err(display_cause_error(&DisplayCause::Silent)),
        }
    }
    Ok(route)
}

#[cfg(test)]
#[path = "display_server_tests.rs"]
mod tests;
