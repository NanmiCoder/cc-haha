use agent_desktop_core::{
    AdapterError, AppInfo, AppInventory, AppInventoryQuery, AppPresentation, Deadline,
    DeliverySemantics, ErrorCode,
};
use serde_json::json;

use crate::system::SharedBus;
use crate::system::registry::registry_app::RegistryApp;

const MISSING_CONNECTION: &str = "The process is running but is not on the accessibility bus. Sandboxed apps (snap, Flatpak) cannot reach it unless the bus is shared. A Chromium browser (Chrome, Chromium) needs --force-renderer-accessibility on its command line: ACCESSIBILITY_ENABLED=1 alone puts it on the bus with no windows. An Electron app needs no accessibility flag, but needs --no-sandbox where its chrome-sandbox is not setuid. A Qt app needs QT_ACCESSIBILITY=1. The registry was read once, so an app launched a moment ago may need a retry.";

pub(crate) fn info(app: &RegistryApp, foreground: bool) -> AppInfo {
    AppInfo {
        name: app.name.clone(),
        pid: app.root.pid().into(),
        bundle_id: super::app_name::desktop_id(&app.facts),
        process_instance: Some(app.facts.instance.clone()),
        presentation: Some(if foreground {
            AppPresentation::Foreground
        } else {
            AppPresentation::Background
        }),
    }
}

/// Collapses the entries one process has on the registry into one. A Qt
/// application opens two accessibility connections, only one of which owns
/// the windows, and listing both would show a single process twice and make
/// its own name ambiguous. The entry that presents windows decides the
/// presentation. Without a window, every entry must have been read before
/// the process can be reported as background.
pub(crate) fn one_entry_per_process(apps: Vec<AppInfo>) -> Vec<AppInfo> {
    let mut merged: Vec<AppInfo> = Vec::with_capacity(apps.len());
    for app in apps {
        match merged
            .iter_mut()
            .find(|seen| seen.pid == app.pid && seen.process_instance == app.process_instance)
        {
            Some(seen) => {
                if app.presentation == Some(AppPresentation::Foreground)
                    || (seen.presentation != Some(AppPresentation::Foreground)
                        && app.presentation.is_none())
                {
                    seen.presentation = app.presentation;
                }
            }
            None => merged.push(app),
        }
    }
    merged
}

pub(crate) fn inventory(bus: &SharedBus, deadline: Deadline) -> Result<AppInventory, AdapterError> {
    crate::system::context::inventory::query(bus, AppInventoryQuery::All, deadline)
}

/// The error for a name that no registry application has but a running
/// process does.
pub(crate) fn missing_connection(query: &str, pid: u32, comm: &str) -> AdapterError {
    if crate::system::shell::is_shell_process(pid) {
        return crate::system::shell::not_this_sessions_shell();
    }
    AdapterError::new(
        ErrorCode::AppNotFound,
        format!("'{query}' is running (pid {pid}) but is not on the accessibility bus"),
    )
    .with_suggestion(MISSING_CONNECTION)
    .with_disposition(DeliverySemantics::not_delivered())
    .with_details(json!({
        "kind": "no_accessibility_connection",
        "pid": pid,
        "process": comm,
    }))
}

/// Registry matches, or the named diagnostic when only a process matches, or
/// the ordinary empty answer when nothing does.
pub(crate) fn scoped_outcome(
    matched: Vec<AppInfo>,
    query: &str,
    running: impl FnOnce(&str) -> Option<(u32, String)>,
) -> Result<Vec<AppInfo>, AdapterError> {
    if !matched.is_empty() {
        return Ok(matched);
    }
    match running(query) {
        Some((pid, comm)) => Err(missing_connection(query, pid, &comm)),
        None => Ok(matched),
    }
}

pub(crate) fn scoped(
    bus: &SharedBus,
    name: &str,
    bundle_id: Option<&str>,
    deadline: Deadline,
) -> Result<Vec<AppInfo>, AdapterError> {
    let inventory = crate::system::context::inventory::query(
        bus,
        AppInventoryQuery::Exact { name, bundle_id },
        deadline,
    )?;
    if !inventory.skipped.is_empty() {
        return Err(
            AdapterError::timeout("The application inventory could not be fully read")
                .with_details(json!({ "skipped": inventory.skipped })),
        );
    }
    Ok(inventory.apps)
}

#[cfg(test)]
#[path = "app_ops_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "app_ops_live_tests.rs"]
mod live_tests;
