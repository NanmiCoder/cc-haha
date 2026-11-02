use agent_desktop_core::{AdapterError, Deadline, ErrorCode, WindowInfo};

use super::window_id;
use super::window_ops::windows_of_process;
use crate::system::process::liveness::{Liveness, liveness};
use crate::system::{SharedBus, shell};

fn not_found(detail: &str) -> AdapterError {
    AdapterError::new(ErrorCode::WindowNotFound, detail)
        .with_suggestion("Run 'list-windows' to see the windows that exist now")
}

/// Checks a stored window against a fresh listing: the process and its
/// start must be the same. The title is not compared because applications
/// retitle their windows, and the id already is the window's address. The
/// listing shows a stopped process's windows, recovered from the display
/// server, so its window may still be there; resolving it is
/// `APP_UNRESPONSIVE` for its application either way, never a closed window.
pub(crate) fn verify(
    expected: &WindowInfo,
    live: Vec<WindowInfo>,
    process: Liveness,
) -> Result<WindowInfo, AdapterError> {
    if process == Liveness::Stopped {
        return Err(AdapterError::app_unresponsive(&expected.app));
    }
    let Some(instance) = expected
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
    else {
        return Err(AdapterError::new(
            ErrorCode::StaleRef,
            "The stored window has no process-instance token to verify",
        ));
    };
    let Some(found) = live.into_iter().find(|window| window.id == expected.id) else {
        return Err(not_found("The window is no longer open"));
    };
    if found.pid != expected.pid || found.process_instance.as_deref() != Some(instance) {
        return Err(not_found(
            "The window id now belongs to a different process",
        ));
    }
    Ok(found)
}

pub(crate) fn resolve_window_strict(
    bus: &SharedBus,
    expected: &WindowInfo,
    deadline: Deadline,
) -> Result<WindowInfo, AdapterError> {
    window_id::decode(&expected.id)?;
    if shell::is_shell_window(expected) {
        shell::window_gate::verify(bus, &expected.id, deadline)?;
        return Ok(expected.clone());
    }
    let pid = expected.pid.get();
    let live = windows_of_process(bus, pid, deadline)?;
    let process = expected
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
        .map_or(Liveness::Alive, |instance| liveness(pid, instance));
    verify(expected, live, process)
}

#[cfg(test)]
#[path = "window_resolve_tests.rs"]
mod tests;
