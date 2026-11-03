use agent_desktop_core::{
    AdapterError, AppInfo, SignalBaseline, SignalCompleteness, SignalFilter, SnapshotSurface,
    SurfaceSignal, WindowFilter,
};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
pub(crate) fn supported_surfaces_impl() -> Vec<SnapshotSurface> {
    vec![
        SnapshotSurface::Window,
        SnapshotSurface::Focused,
        SnapshotSurface::Menu,
        SnapshotSurface::Menubar,
        SnapshotSurface::Sheet,
        SnapshotSurface::Popover,
        SnapshotSurface::Alert,
    ]
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn supported_surfaces_impl() -> Vec<SnapshotSurface> {
    vec![SnapshotSurface::Window]
}

#[cfg(target_os = "macos")]
pub(crate) fn capture_signal_baseline_impl(
    filter: &SignalFilter,
    deadline: Instant,
) -> Result<SignalBaseline, AdapterError> {
    ensure_before_deadline(deadline)?;
    let apps = matching_apps(filter, deadline)?;
    cap_ax_messaging(&apps, deadline)?;
    let windows = if filter.app.is_some() && apps.is_empty() {
        Vec::new()
    } else {
        crate::system::app::app_inventory::list_windows_until(
            &WindowFilter {
                focused_only: false,
                app: filter.app.clone(),
            },
            deadline,
        )?
    };
    ensure_before_deadline(deadline)?;
    let surfaces = surfaces_for_apps(filter, &apps, deadline)?;
    ensure_before_deadline(deadline)?;
    Ok(SignalBaseline {
        windows,
        apps,
        surfaces,
        completeness: SignalCompleteness::complete(),
    })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn capture_signal_baseline_impl(
    _filter: &SignalFilter,
    _deadline: Instant,
) -> Result<SignalBaseline, AdapterError> {
    Err(AdapterError::not_supported("capture_signal_baseline"))
}

#[cfg(target_os = "macos")]
fn matching_apps(filter: &SignalFilter, deadline: Instant) -> Result<Vec<AppInfo>, AdapterError> {
    if let Some(name) = &filter.app {
        return crate::system::app::app_inventory::list_apps_scoped_until(name, None, deadline);
    }
    if filter.process.is_some() {
        return crate::system::app::app_inventory::stabilize_apps_until(deadline, || {
            let inventory = crate::system::app::app_inventory::list_apps_inventory_until(deadline)?;
            let apps = filter_apps(filter, inventory.apps);
            if apps.is_empty() {
                crate::system::app::workspace_apps::require_complete(&inventory.skipped)?;
            }
            Ok(apps)
        });
    }
    let all = crate::system::app::app_inventory::list_apps_complete_until(deadline)?;
    ensure_before_deadline(deadline)?;
    Ok(filter_apps(filter, all))
}

#[cfg(target_os = "macos")]
fn filter_apps(filter: &SignalFilter, all: Vec<AppInfo>) -> Vec<AppInfo> {
    if let Some(name) = &filter.app {
        return all
            .into_iter()
            .filter(|app| app.matches_identifier(name))
            .collect();
    }
    if let Some(process) = &filter.process {
        return all
            .into_iter()
            .filter(|app| {
                app.pid == process.pid
                    && app.process_instance.as_deref() == Some(process.instance.as_str())
            })
            .collect();
    }
    all
}

#[cfg(target_os = "macos")]
fn cap_ax_messaging(apps: &[AppInfo], deadline: Instant) -> Result<(), AdapterError> {
    for app in apps {
        remaining_before_deadline(deadline)?;
        let pid = crate::system::process::process_identity::to_pid_t(app.pid)?;
        let element = crate::tree::element_for_pid(pid);
        crate::tree::properties::attributes::set_messaging_timeout(&element, deadline)?;
    }
    ensure_before_deadline(deadline)
}

#[cfg(target_os = "macos")]
fn surfaces_for_apps(
    filter: &SignalFilter,
    apps: &[AppInfo],
    deadline: Instant,
) -> Result<Vec<SurfaceSignal>, AdapterError> {
    if filter.app.is_none() && filter.process.is_none() {
        return Ok(Vec::new());
    }
    let mut surfaces = Vec::new();
    for app in apps {
        ensure_before_deadline(deadline)?;
        let pid = crate::system::process::process_identity::to_pid_t(app.pid)?;
        for info in crate::tree::surface_inventory::list_surfaces_for_pid(pid, deadline)? {
            if let Some(kind) = map_surface_kind(&info.kind) {
                let process_instance = app.process_instance.clone().ok_or_else(|| {
                    AdapterError::new(
                        agent_desktop_core::ErrorCode::AppUnresponsive,
                        "Surface owner lacks a verified process instance",
                    )
                    .with_details(serde_json::json!({
                        "pid": app.pid,
                        "complete": false,
                    }))
                })?;
                surfaces.push(SurfaceSignal {
                    kind,
                    app: app.name.clone(),
                    pid: app.pid,
                    process_instance,
                    id: info.id,
                    title: info.title,
                });
            }
        }
    }
    Ok(surfaces)
}

#[cfg(target_os = "macos")]
fn map_surface_kind(raw: &str) -> Option<SnapshotSurface> {
    match raw {
        "sheet" => Some(SnapshotSurface::Sheet),
        "popover" => Some(SnapshotSurface::Popover),
        "alert" => Some(SnapshotSurface::Alert),
        "menu" | "context_menu" => Some(SnapshotSurface::Menu),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn remaining_before_deadline(deadline: Instant) -> Result<Duration, AdapterError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(AdapterError::timeout("Signal baseline capture timed out"));
    }
    Ok(remaining)
}

#[cfg(target_os = "macos")]
fn ensure_before_deadline(deadline: Instant) -> Result<(), AdapterError> {
    remaining_before_deadline(deadline).map(|_| ())
}

#[cfg(test)]
#[path = "signals_tests.rs"]
mod tests;
