use agent_desktop_core::{
    AdapterError, Deadline, SignalBaseline, SignalCompleteness, SignalFilter,
};
use serde_json::json;

use super::signal_boundary::{Scope, narrow};
use super::signal_inventory::{Pass, run_pass, skipped_selected};
use super::signal_surfaces::{nested_surface_signals, sheet_signals};
use crate::system::SharedBus;
use crate::system::app::app_ops::{info, one_entry_per_process};
use crate::system::focus::focus_is_indeterminate;
use crate::system::menu::inventory::scan_windows;
use crate::system::menu::inventory_reader::Inventory;
use crate::system::menu::surface_scan::NestedScan;
use crate::system::process::proc_stat;
use crate::system::process::unresponsive::first_stopped;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::registry::registry_app::RegistryApp;
use crate::system::registry::registry_frames::RootRead;
use crate::system::registry::{Registry, read_registry_for};
use agent_desktop_core::AppInfo;
use std::collections::BTreeSet;

trait CaptureWorld {
    fn registry(&self, pid: Option<u32>, deadline: Deadline) -> Result<Registry, AdapterError>;
    fn pass(
        &self,
        registry: &Registry,
        select: &dyn Fn(&RegistryApp) -> bool,
        deadline: Deadline,
    ) -> Result<Pass, AdapterError>;
    fn is_stopped(&self, pid: u32) -> bool;
    fn nested(&self, windows: &[ListedWindow], deadline: Deadline) -> NestedScan;
}

struct BusWorld<'a>(&'a SharedBus);

impl CaptureWorld for BusWorld<'_> {
    fn registry(&self, pid: Option<u32>, deadline: Deadline) -> Result<Registry, AdapterError> {
        read_registry_for(self.0, pid, deadline)
    }

    fn pass(
        &self,
        registry: &Registry,
        select: &dyn Fn(&RegistryApp) -> bool,
        deadline: Deadline,
    ) -> Result<Pass, AdapterError> {
        run_pass(self.0, registry, select, deadline)
    }

    fn is_stopped(&self, pid: u32) -> bool {
        proc_stat::is_stopped(pid)
    }

    fn nested(&self, windows: &[ListedWindow], deadline: Deadline) -> NestedScan {
        let mut inventory = Inventory::new(self.0, deadline);
        scan_windows(windows, |window| inventory.read(window))
    }
}

fn scope_of(filter: &SignalFilter) -> Scope {
    if filter.app.is_some() || filter.process.is_some() {
        Scope::Scoped
    } else {
        Scope::Unscoped
    }
}

pub(in crate::system) fn selector(filter: &SignalFilter) -> impl Fn(&RegistryApp) -> bool + '_ {
    move |app| match &filter.process {
        Some(process) => app.root.pid() == process.pid.get(),
        None => filter.app.as_deref().is_none_or(|query| app.matches(query)),
    }
}

fn stopped_scoped_target(
    world: &impl CaptureWorld,
    registry: &Registry,
    select: &dyn Fn(&RegistryApp) -> bool,
) -> Option<AdapterError> {
    let app = first_stopped(registry, select, |pid| world.is_stopped(pid))?;
    Some(
        AdapterError::app_unresponsive(&app.name).with_details(json!({
            "app": app.name,
            "pid": app.root.pid(),
            "process_instance": app.facts.instance,
            "retryable": false,
        })),
    )
}

fn assemble(
    registry: &Registry,
    pass: &Pass,
    scope: Scope,
    nested: &NestedScan,
    unread: bool,
) -> SignalBaseline {
    let read = pass
        .outcomes
        .iter()
        .all(|outcome| outcome.read == RootRead::Read)
        && !unread;
    let scoped = scope == Scope::Scoped;
    let surfaces = if scoped {
        let mut surfaces = sheet_signals(&pass.windows, &registry.apps);
        surfaces.extend(nested_surface_signals(
            nested,
            &pass.windows,
            &registry.apps,
        ));
        surfaces
    } else {
        Vec::new()
    };
    SignalBaseline {
        windows: pass.infos(),
        apps: apps_of(&pass.windows, &registry.apps),
        surfaces,
        completeness: SignalCompleteness {
            windows: read
                && pass.menu_focus_complete
                && !focus_is_indeterminate(&pass.candidates, pass.focused),
            apps: read,
            surfaces: scoped && read && nested.complete,
        },
    }
}

fn capture(
    world: &impl CaptureWorld,
    filter: &SignalFilter,
    deadline: Deadline,
) -> Result<SignalBaseline, AdapterError> {
    deadline.ensure_remaining()?;
    let scope = scope_of(filter);
    let registry = world.registry(filter.process.as_ref().map(|p| p.pid.get()), deadline)?;
    let select = selector(filter);
    if scope == Scope::Scoped
        && let Some(error) = stopped_scoped_target(world, &registry, &select)
    {
        return Err(error);
    }
    let pass = world.pass(&registry, &select, deadline)?;
    let nested = match scope {
        Scope::Scoped => world.nested(&pass.windows, deadline),
        Scope::Unscoped => NestedScan::complete_and_empty(),
    };
    let unread = skipped_selected(&registry, &pass, &select);
    let baseline = assemble(&registry, &pass, scope, &nested, unread);
    deadline.ensure_remaining()?;
    Ok(baseline)
}

/// What the desktop looks like now, for core's `wait --event` to diff. The
/// filter selects apps before any frame is read. Every error that leaves is
/// `TIMEOUT`, `APP_UNRESPONSIVE` for a stopped scoped target, or the fatal
/// missing-bus error.
pub(crate) fn capture_signal_baseline(
    bus: &SharedBus,
    filter: &SignalFilter,
    deadline: Deadline,
) -> Result<SignalBaseline, AdapterError> {
    capture(&BusWorld(bus), filter, deadline)
        .map_err(|error| narrow(error, scope_of(filter), deadline, || bus.forget_cached()))
}

#[cfg(test)]
#[path = "signal_capture_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "signal_capture_fixture.rs"]
mod signal_capture_fixture;

#[cfg(test)]
#[path = "signal_capture_select_tests.rs"]
mod select_tests;

/// The applications that own at least one listed window, one entry per
/// process. A helper that answers on the registry with no frame never
/// appears, and a window that opens under a running process adds no app.
pub(crate) fn apps_of(windows: &[ListedWindow], registry_apps: &[RegistryApp]) -> Vec<AppInfo> {
    let owners: BTreeSet<usize> = windows.iter().map(|window| window.app).collect();
    one_entry_per_process(
        owners
            .into_iter()
            .filter_map(|index| registry_apps.get(index))
            .map(|app| info(app, true))
            .collect(),
    )
}

#[cfg(test)]
#[path = "signal_population_tests.rs"]
mod population_tests;
