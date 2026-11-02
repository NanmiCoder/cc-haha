use std::collections::HashSet;

use agent_desktop_core::{AdapterError, AppInventory, AppInventoryQuery, Deadline};

use crate::system::SharedBus;
use crate::system::app::app_ops::{info, one_entry_per_process, scoped_outcome};
use crate::system::process::unresponsive::{settle_matches, stopped_target};
use crate::system::process::{proc_scan::find_running, proc_stat};
use crate::system::registry::app_outcome::AppOutcome;
use crate::system::registry::registry_app::RegistryApp;
use crate::system::registry::registry_frames::RootRead;
use crate::system::registry::{Registry, read_registry_query};
use crate::system::signal::signal_inventory::read_selected;

pub(crate) fn matches(query: AppInventoryQuery<'_>, app: &RegistryApp) -> bool {
    match query {
        AppInventoryQuery::All => true,
        AppInventoryQuery::NameOrAlias(name) => {
            query.matches_display_name(&app.name) || app.matches(name)
        }
        AppInventoryQuery::Exact { name, bundle_id } => match bundle_id {
            Some(id) => crate::system::app::app_name::desktop_id(&app.facts)
                .is_some_and(|actual| actual.eq_ignore_ascii_case(id)),
            None => app.matches(name),
        },
    }
}

/// Reads one selected registry population, then enriches only its presentation.
pub(crate) fn query(
    bus: &SharedBus,
    query: AppInventoryQuery<'_>,
    deadline: Deadline,
) -> Result<AppInventory, AdapterError> {
    let mut registry = read_registry_query(
        bus,
        &crate::system::registry::app_query::AppQuery {
            pid: None,
            select: &|app| matches(query, app),
            enrich: true,
        },
        deadline,
    )?;
    if matches!(query, AppInventoryQuery::Exact { .. }) {
        registry
            .skipped
            .retain(|record| record["confirmed_gone"] != true);
    }
    let (windows, outcomes) = if matches!(query, AppInventoryQuery::Exact { .. }) {
        (Vec::new(), Vec::new())
    } else {
        read_selected(bus, &registry, |_| true, deadline)?
    };
    let windowed = windows.into_iter().map(|window| window.app).collect();
    finish(registry, query, &windowed, &outcomes)
}

fn finish(
    mut registry: Registry,
    query: AppInventoryQuery<'_>,
    windowed: &HashSet<usize>,
    outcomes: &[AppOutcome],
) -> Result<AppInventory, AdapterError> {
    if let AppInventoryQuery::NameOrAlias(name) = query {
        let exact = one_entry_per_process(
            registry
                .apps
                .iter()
                .filter(|app| app.matches(name))
                .map(|app| info(app, false))
                .collect(),
        );
        let exact = settle_matches(exact, || {
            stopped_target(&registry, |app| app.matches(name), proc_stat::is_stopped)
        })?;
        if !registry.apps.iter().any(|app| matches(query, app))
            && registry
                .skipped
                .iter()
                .all(|record| record["confirmed_gone"] == true)
        {
            scoped_outcome(exact, name, find_running)?;
        }
    }
    let incomplete: HashSet<u64> = registry
        .skipped
        .iter()
        .filter(|record| record["confirmed_gone"] != true)
        .filter_map(|record| record["pid"].as_u64())
        .collect();
    let apps = one_entry_per_process(
        registry
            .apps
            .iter()
            .enumerate()
            .filter(|(_, app)| matches(query, app))
            .map(|(index, app)| {
                let mut app = info(app, windowed.contains(&index));
                if matches!(query, AppInventoryQuery::Exact { .. })
                    || (!windowed.contains(&index)
                        && (incomplete.contains(&u64::from(app.pid.get()))
                            || !outcomes.iter().any(|outcome| {
                                outcome.app == index && outcome.read == RootRead::Read
                            })))
                {
                    app.presentation = None;
                }
                app
            })
            .collect(),
    );
    let apps = match query {
        AppInventoryQuery::Exact { name, bundle_id } => {
            let apps = settle_matches(apps, || {
                stopped_target(&registry, |_| true, proc_stat::is_stopped)
            })?;
            if registry.skipped.is_empty() {
                scoped_outcome(apps, bundle_id.unwrap_or(name), find_running)?
            } else {
                apps
            }
        }
        _ => apps,
    };
    if !matches!(query, AppInventoryQuery::Exact { .. }) {
        for (index, app) in registry
            .apps
            .iter()
            .enumerate()
            .filter(|(_, app)| matches(query, app))
        {
            if !outcomes
                .iter()
                .any(|outcome| outcome.app == index && outcome.read == RootRead::Read)
            {
                registry.skipped.push(serde_json::json!({
                    "pid": app.root.pid(), "bus": app.root.bus_name(),
                    "reason": "the window inventory could not be fully read",
                }));
            }
        }
    }
    Ok(AppInventory {
        apps,
        skipped: registry.skipped,
    })
}

#[cfg(test)]
#[path = "inventory_tests.rs"]
mod tests;
