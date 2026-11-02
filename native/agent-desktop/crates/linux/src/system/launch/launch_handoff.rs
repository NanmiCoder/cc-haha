use std::collections::HashSet;

use agent_desktop_core::Deadline;

use super::baseline::{Baseline, capture, same_executable};
use super::launch_step::Step;
use crate::system::SharedBus;
use crate::system::process::running_app::Running;

fn select_owner(
    before: &[(Running, HashSet<String>)],
    after: &[(Running, HashSet<String>)],
) -> Step {
    let mut owners = after.iter().filter_map(|(owner, windows)| {
        before.iter().find_map(|(resident, known)| {
            (resident.identity() == owner.identity()
                && windows.iter().any(|id| !known.contains(id)))
            .then_some(owner)
        })
    });
    match (owners.next(), owners.next()) {
        (None, _) => Step::Wait,
        (Some(owner), None) => Step::Owner(owner.clone()),
        (Some(first), Some(second)) => Step::Ambiguous(
            [first.pid, second.pid]
                .into_iter()
                .chain(owners.map(|owner| owner.pid))
                .collect(),
        ),
    }
}

pub(super) fn observe(
    bus: &SharedBus,
    baseline: &Baseline,
    apps: &[Running],
    deadline: Deadline,
) -> Step {
    let after: Vec<_> = apps
        .iter()
        .filter(|app| {
            baseline.residents.iter().any(|(resident, _)| {
                resident.identity() == app.identity()
                    && same_executable(resident.executable.as_ref(), app)
            })
        })
        .filter_map(|owner| {
            capture(bus, owner, deadline)
                .ok()
                .map(|windows| (owner.clone(), windows))
        })
        .collect();
    select_owner(&baseline.residents, &after)
}

#[cfg(test)]
#[path = "launch_handoff_tests.rs"]
mod tests;
