use serde_json::json;

use crate::{
    AdapterError, AppError, AppInfo, Deadline, ErrorCode, ProcessIdentity, WindowInfo,
    adapter::{PlatformAdapter, WindowFilter},
};

pub(crate) fn resolve_app(
    app: Option<&str>,
    adapter: &dyn PlatformAdapter,
    deadline: Deadline,
) -> Result<AppInfo, AppError> {
    if let Some(name) = app {
        let candidates = exact_apps(adapter, name, None, deadline)?;
        return select_unique_app(candidates, name);
    }
    let focused = adapter.list_windows(
        &WindowFilter {
            focused_only: true,
            app: None,
        },
        deadline,
    )?;
    let window = match focused.as_slice() {
        [] => {
            return Err(AdapterError::new(
                ErrorCode::AppNotFound,
                "No focused application was found when --app was omitted",
            )
            .unsent()
            .into());
        }
        [window] => window,
        _ => {
            return Err(AdapterError::ambiguous_target(
                "A unique focused window is required when --app is omitted",
            )
            .with_details(json!({ "focused_window_count": focused.len() }))
            .into());
        }
    };
    resolve_app_owning(window, adapter, deadline)
}

/// The application that owns `window`, narrowed to the window's exact process
/// instance, so a second running copy of the same application is never chosen.
pub(crate) fn resolve_app_owning(
    window: &WindowInfo,
    adapter: &dyn PlatformAdapter,
    deadline: Deadline,
) -> Result<AppInfo, AppError> {
    let instance = window
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
        .ok_or_else(|| {
            AdapterError::new(
                ErrorCode::ActionNotSupported,
                "Window has no process-instance identity",
            )
        })?;
    let same_pid = exact_apps(adapter, &window.app, None, deadline)?
        .into_iter()
        .filter(|candidate| candidate.pid == window.pid)
        .collect::<Vec<_>>();
    reject_incomplete_app_identity(&same_pid, &window.app)?;
    let candidates = same_pid
        .into_iter()
        .filter(|candidate| candidate.process_instance.as_deref() == Some(instance))
        .collect();
    select_unique_app(candidates, &window.app)
}

fn select_unique_app(mut candidates: Vec<AppInfo>, label: &str) -> Result<AppInfo, AppError> {
    reject_incomplete_app_identity(&candidates, label)?;
    match candidates.len() {
        0 => Err(AdapterError::new(
            ErrorCode::AppNotFound,
            format!("Application '{label}' was not found with exact process identity"),
        )
        .with_suggestion("Application name as reported by list-apps")
        .unsent()
        .into()),
        1 => Ok(candidates.swap_remove(0)),
        _ => {
            let candidate_pids = candidates.iter().map(|c| c.pid).collect::<Vec<_>>();
            let summaries = candidates
                .iter()
                .take(10)
                .map(|candidate| {
                    json!({
                        "name": candidate.name,
                        "pid": candidate.pid,
                        "process_instance": candidate.process_instance,
                    })
                })
                .collect::<Vec<_>>();
            Err(AdapterError::ambiguous_process_target_with_details(
                format!("Multiple application instances matched '{label}'"),
                &candidate_pids,
                json!({
                    "candidate_count": candidates.len(),
                    "candidate_pids": candidate_pids,
                    "candidate_summaries_truncated": candidates.len() > summaries.len(),
                    "candidates": summaries,
                }),
            )
            .into())
        }
    }
}

fn reject_incomplete_app_identity(candidates: &[AppInfo], label: &str) -> Result<(), AppError> {
    let incomplete_count = candidates
        .iter()
        .filter(|candidate| {
            candidate
                .process_instance
                .as_deref()
                .is_none_or(str::is_empty)
        })
        .count();
    if incomplete_count == 0 {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("Application inventory for '{label}' has incomplete process identity"),
    )
    .with_details(json!({
        "candidate_count": candidates.len(),
        "incomplete_identity_count": incomplete_count,
    }))
    .into())
}

pub(crate) fn process_identity(app: &AppInfo) -> Result<ProcessIdentity, AppError> {
    let instance = app
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
        .ok_or_else(|| {
            AdapterError::new(
                ErrorCode::ActionNotSupported,
                "Application has no process-instance identity",
            )
        })?;
    Ok(ProcessIdentity::new(app.pid, instance))
}

pub(crate) fn revalidate_app_for_mutation(
    adapter: &dyn PlatformAdapter,
    expected: &AppInfo,
    deadline: Deadline,
) -> Result<AppInfo, AppError> {
    let expected_identity = process_identity(expected)?;
    let same_pid = exact_apps(
        adapter,
        &expected.name,
        expected.bundle_id.as_deref(),
        deadline,
    )?
    .into_iter()
    .filter(|candidate| candidate.pid == expected.pid)
    .collect::<Vec<_>>();
    reject_incomplete_app_identity(&same_pid, &expected.name)?;
    let mut exact = same_pid
        .into_iter()
        .filter(|candidate| {
            candidate.process_instance.as_deref() == Some(expected_identity.instance.as_str())
                && crate::app_name_matches(&candidate.name, &expected.name)
                && expected.bundle_id.as_deref().is_none_or(|expected_bundle| {
                    candidate
                        .bundle_id
                        .as_deref()
                        .is_some_and(|actual| actual.eq_ignore_ascii_case(expected_bundle))
                })
        })
        .collect::<Vec<_>>();
    match exact.len() {
        1 => Ok(exact.swap_remove(0)),
        0 => Err(AdapterError::new(
            ErrorCode::StaleRef,
            "Application identity changed before mutation",
        )
        .into()),
        _ => Err(AdapterError::ambiguous_target(
            "Multiple exact application identities remained before mutation",
        )
        .with_details(json!({ "candidate_count": exact.len() }))
        .into()),
    }
}

fn exact_apps(
    adapter: &dyn PlatformAdapter,
    name: &str,
    bundle_id: Option<&str>,
    deadline: Deadline,
) -> Result<Vec<AppInfo>, AppError> {
    let inventory = adapter.query_app_inventory(
        crate::AppInventoryQuery::Exact { name, bundle_id },
        deadline,
    )?;
    if !inventory.skipped.is_empty() {
        return Err(AdapterError::app_unresponsive(name)
            .with_details(
                json!({ "kind": "app_inventory_incomplete", "skipped": inventory.skipped }),
            )
            .unsent()
            .into());
    }
    Ok(inventory.apps)
}

#[cfg(test)]
#[path = "app_lookup_tests.rs"]
mod tests;
