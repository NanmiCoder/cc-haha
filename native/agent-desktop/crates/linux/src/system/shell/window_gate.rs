use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use super::identity::{ShellRoot, find_root};
use super::light::{LiveNodes, Nodes};
use crate::system::{SharedBus, window::window_id};
use crate::tree::AtspiElement;

fn stale(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::StaleRef, message)
        .with_suggestion("Run 'snapshot' to refresh, then retry with the new ref")
}

/// Whether a shell window id still names a live container of the shell that
/// runs now: the bus name must be the current shell's, so an id from before
/// a shell restart is refused, and the container must answer.
pub(crate) fn check<N: Nodes>(
    nodes: &N,
    current: &ShellRoot,
    bus_name: &str,
    path: &str,
) -> Result<(), AdapterError> {
    if bus_name != current.bus_name {
        return Err(stale("The shell was restarted since this ref was taken"));
    }
    let element = AtspiElement::new(bus_name, path, current.pid);
    nodes
        .read(&element)
        .map(|_| ())
        .map_err(|_| stale("The shell surface this ref was taken in no longer exists"))
}

pub(crate) fn verify(
    bus: &SharedBus,
    window_id: &str,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let (bus_name, path) = window_id::decode(window_id)?;
    let current = find_root(bus, deadline)?;
    let nodes = LiveNodes::new(bus.get(deadline)?.inner().clone(), deadline);
    check(&nodes, &current, &bus_name, &path)
}

#[cfg(test)]
#[path = "window_gate_tests.rs"]
mod tests;
