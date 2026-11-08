use agent_desktop_core::{AdapterError, AppInfo, ErrorCode, ProcessId, WindowFilter, WindowInfo};
use std::time::Instant;

use crate::system::{app::workspace_apps, process::process_apps, window::window_inventory};

pub(crate) fn list_apps_complete_until(deadline: Instant) -> Result<Vec<AppInfo>, AdapterError> {
    stabilize_apps_until(deadline, || capture_complete_apps(deadline))
}

pub(crate) fn list_apps_inventory_until(
    deadline: Instant,
) -> Result<agent_desktop_core::AppInventory, AdapterError> {
    let mut skipped = Vec::new();
    let apps = stabilize_apps_until(deadline, || {
        let inventory = workspace_apps::list_apps_inventory_until(deadline)?;
        skipped = inventory.skipped;
        let apps = complete_apps_from_sources(
            Ok(inventory.apps),
            process_apps::list_apps_until(deadline),
        )?;
        validate_app_instances(apps)
    })?;
    Ok(agent_desktop_core::AppInventory { apps, skipped })
}

pub(crate) fn list_apps_scoped_until(
    name: &str,
    bundle_id: Option<&str>,
    deadline: Instant,
) -> Result<Vec<AppInfo>, AdapterError> {
    stabilize_apps_until(deadline, || capture_scoped_apps(name, bundle_id, deadline))
}

fn capture_complete_apps(deadline: Instant) -> Result<Vec<AppInfo>, AdapterError> {
    ensure_before_deadline(deadline)?;
    let inventory = workspace_apps::list_apps_inventory_until(deadline)?;
    workspace_apps::require_complete(&inventory.skipped)?;
    let apps =
        complete_apps_from_sources(Ok(inventory.apps), process_apps::list_apps_until(deadline))?;
    ensure_before_deadline(deadline)?;
    validate_app_instances(apps)
}

fn capture_scoped_apps(
    name: &str,
    bundle_id: Option<&str>,
    deadline: Instant,
) -> Result<Vec<AppInfo>, AdapterError> {
    ensure_before_deadline(deadline)?;
    let process = if bundle_id.is_none() {
        process_apps::list_apps_scoped_until(name, deadline)
    } else {
        Ok(Vec::new())
    };
    let apps = scoped_apps_from_sources(
        workspace_apps::list_apps_scoped_until(name, bundle_id, deadline),
        process,
    )?;
    ensure_before_deadline(deadline)?;
    validate_app_instances(apps)
}

pub(in crate::system) fn scoped_apps_from_sources(
    workspace: Result<agent_desktop_core::AppInventory, AdapterError>,
    process: Result<Vec<AppInfo>, AdapterError>,
) -> Result<Vec<AppInfo>, AdapterError> {
    let workspace = workspace?;
    let apps = complete_apps_from_sources(Ok(workspace.apps), process)?;
    if apps.is_empty() {
        workspace_apps::require_complete(&workspace.skipped)?;
    }
    Ok(apps)
}

pub(in crate::system) fn stabilize_apps_until(
    deadline: Instant,
    mut capture: impl FnMut() -> Result<Vec<AppInfo>, AdapterError>,
) -> Result<Vec<AppInfo>, AdapterError> {
    let mut previous: Option<Vec<AppInfo>> = None;
    let mut attempts = 0_u64;
    let mut churn_events = 0_u64;
    let mut last_failure: Option<AdapterError> = None;
    loop {
        if Instant::now() >= deadline {
            return Err(unstable_apps_error(
                attempts,
                churn_events,
                last_failure.as_ref(),
            ));
        }
        attempts += 1;
        match capture() {
            Ok(current) => {
                if previous
                    .as_ref()
                    .is_some_and(|prior| app_signature(prior) == app_signature(&current))
                {
                    return Ok(current);
                }
                churn_events += u64::from(previous.is_some());
                previous = Some(current);
                last_failure = None;
            }
            Err(error) if retryable_inventory_error(&error) => {
                previous = None;
                last_failure = Some(error);
            }
            Err(error) if error.code == ErrorCode::Timeout && last_failure.is_some() => {
                return Err(unstable_apps_error(
                    attempts,
                    churn_events,
                    last_failure.as_ref(),
                ));
            }
            Err(error) => return Err(error),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            std::thread::sleep(remaining.min(std::time::Duration::from_millis(5)));
        }
    }
}

fn app_signature(apps: &[AppInfo]) -> Vec<(ProcessId, &str, Option<&str>, Option<&str>)> {
    let mut signature = apps
        .iter()
        .map(|app| {
            (
                app.pid,
                app.name.as_str(),
                app.bundle_id.as_deref(),
                app.process_instance.as_deref(),
            )
        })
        .collect::<Vec<_>>();
    signature.sort_unstable();
    signature
}

fn retryable_inventory_error(error: &AdapterError) -> bool {
    error.code == ErrorCode::AppUnresponsive && error.is_explicitly_retryable()
}

fn unstable_apps_error(
    attempts: u64,
    churn_events: u64,
    last_failure: Option<&AdapterError>,
) -> AdapterError {
    let mut details = serde_json::json!({
        "kind": "application_inventory_unstable",
        "attempts": attempts,
        "churn_events": churn_events,
        "retryable": true,
    });
    if let Some(error) = last_failure {
        details["last_failure"] = serde_json::json!(error.message);
        if let Some(failure_details) = &error.details {
            details["last_failure_details"] = failure_details.clone();
        }
    }
    AdapterError::timeout("macOS application inventory did not stabilize before the deadline")
        .with_suggestion("Retry after application launches and exits settle")
        .with_details(details)
}

pub(crate) fn list_windows_until(
    filter: &WindowFilter,
    deadline: Instant,
) -> Result<Vec<WindowInfo>, AdapterError> {
    window_inventory::list_windows_until(filter, deadline)
}

fn complete_apps_from_sources(
    workspace: Result<Vec<AppInfo>, AdapterError>,
    process: Result<Vec<AppInfo>, AdapterError>,
) -> Result<Vec<AppInfo>, AdapterError> {
    let (workspace, process) = match (workspace, process) {
        (Ok(workspace), Ok(process)) => (workspace, process),
        (workspace, process) => return Err(required_sources_failed(&workspace, &process)),
    };
    let mut apps = Vec::new();
    merge_apps(&mut apps, workspace)?;
    merge_apps(&mut apps, process)?;
    sort_apps(&mut apps);
    Ok(apps)
}

fn required_sources_failed(
    workspace: &Result<Vec<AppInfo>, AdapterError>,
    process: &Result<Vec<AppInfo>, AdapterError>,
) -> AdapterError {
    let failures = [
        source_failure("ns_workspace", workspace),
        source_failure("ps", process),
    ]
    .into_iter()
    .filter(|failure| !failure["code"].is_null())
    .collect::<Vec<_>>();
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "A required macOS app inventory source failed",
    )
    .with_suggestion("Retry the event observation with a fresh complete inventory")
    .with_details(serde_json::json!({
        "kind": "inventory_sources",
        "retryable": true,
        "complete": false,
        "failures": failures,
    }))
}

fn source_failure(source: &str, result: &Result<Vec<AppInfo>, AdapterError>) -> serde_json::Value {
    let error = result.as_ref().err();
    let Some(error) = error else {
        return serde_json::json!({});
    };
    let mut failure = serde_json::json!({
        "source": source, "code": error.code.as_str(), "message": error.message,
    });
    if let Some(details) = &error.details {
        failure["details"] = details.clone();
    }
    failure
}

fn ensure_before_deadline(deadline: Instant) -> Result<(), AdapterError> {
    if Instant::now() >= deadline {
        return Err(AdapterError::timeout("macOS app inventory timed out"));
    }
    Ok(())
}

fn merge_apps(apps: &mut Vec<AppInfo>, incoming: Vec<AppInfo>) -> Result<(), AdapterError> {
    for app in incoming {
        let incoming_instance = app.process_instance.as_deref().ok_or_else(|| {
            incomplete_identity_error(app.pid, "source omitted the process instance token")
        })?;
        if let Some(existing) = apps.iter_mut().find(|existing| existing.pid == app.pid) {
            if existing.process_instance.as_deref() != Some(incoming_instance) {
                return Err(incomplete_identity_error(
                    app.pid,
                    "process instance changed between inventory sources",
                ));
            }
            if existing.bundle_id.is_none() {
                existing.bundle_id = app.bundle_id;
            }
        } else {
            apps.push(app);
        }
    }
    Ok(())
}

fn validate_app_instances(apps: Vec<AppInfo>) -> Result<Vec<AppInfo>, AdapterError> {
    for app in &apps {
        let captured = app.process_instance.as_deref().ok_or_else(|| {
            incomplete_identity_error(app.pid, "inventory omitted the process instance token")
        })?;
        let pid = crate::system::process::process_identity::to_pid_t(app.pid)?;
        if crate::system::process::process_identity::token_for_pid(pid)?.as_deref()
            != Some(captured)
        {
            return Err(incomplete_identity_error(
                app.pid,
                "process instance changed before inventory completion",
            ));
        }
    }
    Ok(apps)
}

fn incomplete_identity_error(pid: ProcessId, phase: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Application inventory changed while exact identity was being assembled",
    )
    .with_details(serde_json::json!({
        "kind": "inventory_identity_race",
        "pid": pid,
        "phase": phase,
        "complete": false,
        "retryable": true,
    }))
    .with_suggestion("Retry after the application process list stabilizes")
}

fn sort_apps(apps: &mut [AppInfo]) {
    apps.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then_with(|| a.pid.cmp(&b.pid))
    });
}

#[cfg(test)]
fn matching_pids(apps: &[AppInfo], app_name: &str) -> Vec<ProcessId> {
    let mut pids = apps
        .iter()
        .filter(|app| agent_desktop_core::app_name_matches(&app.name, app_name))
        .map(|app| app.pid)
        .collect::<Vec<_>>();
    pids.sort_unstable();
    pids.dedup();
    pids
}

#[cfg(test)]
#[path = "app_inventory_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "app_inventory_adapter_tests.rs"]
pub(crate) mod adapter_tests;
