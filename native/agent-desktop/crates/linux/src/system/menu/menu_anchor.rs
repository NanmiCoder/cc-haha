use agent_desktop_core::{AdapterError, Deadline, ProcessIdentity, WindowInfo};

use super::inventory_reader::Inventory;
use super::menu_surface::{PopupReader, find_popups, vanished};
use crate::system::SharedBus;
use crate::system::registry::read_registry_for;
use crate::system::registry::registry_app::RegistryApp;
use crate::system::registry::registry_frames::RootRead;
use crate::system::signal::signal_inventory::read_selected;
use crate::system::window::window_id;
use crate::tree::AtspiElement;

fn owned_by(pid: u32) -> impl Fn(&RegistryApp) -> bool {
    move |app| app.root.pid() == pid
}

/// Prefer each process window; a process without windows is read from its
/// application roots, where a popup frame may live without being a window.
fn targets(
    roots: Vec<AtspiElement>,
    windows: Vec<WindowInfo>,
) -> Result<Vec<AtspiElement>, AdapterError> {
    if windows.is_empty() {
        Ok(roots)
    } else {
        windows
            .into_iter()
            .map(|window| {
                let (bus_name, path) = window_id::decode(&window.id)?;
                Ok(AtspiElement::new(bus_name, path, window.pid.get()))
            })
            .collect()
    }
}

fn popups_at(reader: &mut Inventory<'_>, window: &AtspiElement) -> Result<bool, AdapterError> {
    reader.select(window);
    match find_popups(reader) {
        Ok(popups) => Ok(!popups.is_empty()),
        Err(error) if vanished(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

fn collect_targets(
    bus: &SharedBus,
    pid: u32,
    deadline: Deadline,
) -> Result<(Vec<AtspiElement>, bool), AdapterError> {
    let registry = read_registry_for(bus, Some(pid), deadline)?;
    let owned = owned_by(pid);
    let (windows, outcomes) = read_selected(bus, &registry, &owned, deadline)?;
    let unread = outcomes
        .iter()
        .any(|outcome| outcome.read != RootRead::Read);
    let owners: Vec<&RegistryApp> = registry.apps.iter().filter(|app| owned(app)).collect();
    let roots = owners.iter().map(|app| app.root.clone()).collect();
    Ok((
        targets(
            roots,
            windows.into_iter().map(|window| window.info).collect(),
        )?,
        unread,
    ))
}

/// A closed answer is valid only when every read that could have shown a menu
/// was whole. An incomplete read proves nothing about an unseen menu.
fn settle(incomplete: bool) -> Result<bool, AdapterError> {
    if !incomplete {
        return Ok(false);
    }
    Err(AdapterError::timeout(
        "The menu state could not be read in full",
    ))
}

/// Whether the process has an open menu now. The wait loop checks process
/// liveness around each read and maps a stopped process to its own error.
pub(crate) fn menu_open(
    bus: &SharedBus,
    process: &ProcessIdentity,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let (targets, unread) = collect_targets(bus, process.pid.get(), deadline)?;
    let mut inventory = Inventory::new(bus, deadline);
    let mut incomplete = unread;
    for target in targets {
        if popups_at(&mut inventory, &target)? {
            return Ok(true);
        }
        incomplete |= inventory.incomplete();
    }
    settle(incomplete)
}

#[cfg(test)]
#[path = "menu_anchor_tests.rs"]
mod tests;
