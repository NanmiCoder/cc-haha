use std::collections::HashSet;

use agent_desktop_core::{AdapterError, Deadline, ProcessIdentity};

use super::Running;
use crate::system::SharedBus;
use crate::system::process::executable_identity::ExecutableIdentity;
use crate::system::registry::registry_app::RegistryApp;
use crate::system::registry::registry_frames::RootRead;
use crate::system::registry::{Registry, read_registry_for};
use crate::system::signal::signal_inventory::{Pass, run_pass, skipped_selected};

pub(super) struct Baseline {
    pub(super) processes: HashSet<ProcessIdentity>,
    pub(super) residents: Vec<(Running, HashSet<String>)>,
}

pub(super) fn same_executable(identity: Option<&ExecutableIdentity>, owner: &Running) -> bool {
    identity
        .zip(owner.executable.as_ref())
        .is_some_and(|(wanted, actual)| wanted.executable == actual.executable)
}

pub(super) fn prepare(
    bus: &SharedBus,
    identity: &Option<ExecutableIdentity>,
    running: &[Running],
    deadline: Deadline,
) -> Baseline {
    let residents = running
        .iter()
        .filter(|owner| same_executable(identity.as_ref(), owner))
        .filter_map(|owner| {
            capture(bus, owner, deadline)
                .ok()
                .map(|windows| (owner.clone(), windows))
        })
        .collect();
    Baseline {
        processes: running.iter().map(Running::identity).collect(),
        residents,
    }
}

fn owns(owner: &Running, app: &RegistryApp) -> bool {
    app.root.pid() == owner.pid && app.facts.instance == owner.instance
}

fn ids_of(
    registry: &Registry,
    pass: &Pass,
    owner: &Running,
) -> Result<HashSet<String>, AdapterError> {
    let select = |app: &RegistryApp| owns(owner, app);
    if !registry.skipped.is_empty()
        || !registry.apps.iter().any(select)
        || !pass.recovered.is_empty()
        || skipped_selected(registry, pass, select)
        || pass
            .outcomes
            .iter()
            .any(|outcome| outcome.read != RootRead::Read)
    {
        return Err(AdapterError::timeout(
            "The running application's windows could not be fully read before launch",
        ));
    }
    Ok(pass
        .windows
        .iter()
        .map(|window| window.info.id.clone())
        .collect())
}

pub(super) fn capture(
    bus: &SharedBus,
    owner: &Running,
    deadline: Deadline,
) -> Result<HashSet<String>, AdapterError> {
    let registry = read_registry_for(bus, Some(owner.pid), deadline)?;
    let pass = run_pass(bus, &registry, |app| owns(owner, app), deadline)?;
    ids_of(&registry, &pass, owner)
}

#[cfg(test)]
#[path = "launch_baseline_tests.rs"]
mod tests;
