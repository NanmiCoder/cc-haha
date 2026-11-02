use agent_desktop_core::{AdapterError, WindowFilter, WindowInfo};
use std::time::Instant;

use crate::system::window::cg_window;

#[cfg(test)]
fn apps_from_window_records(
    records: &[cg_window::WindowRecord],
) -> Vec<agent_desktop_core::AppInfo> {
    let mut seen_pids = rustc_hash::FxHashSet::default();
    let mut apps = Vec::new();

    for record in records {
        if !seen_pids.insert(record.pid) {
            continue;
        }
        apps.push(agent_desktop_core::AppInfo {
            name: record.app_name.clone(),
            pid: agent_desktop_core::ProcessId::try_from(record.pid)
                .expect("fixture pid must be positive"),
            bundle_id: None,
            process_instance: record.process_instance.clone(),
            presentation: None,
        });
    }

    apps
}

pub(crate) fn list_windows_until(
    filter: &WindowFilter,
    deadline: Instant,
) -> Result<Vec<WindowInfo>, AdapterError> {
    let Some(app_filter) = filter.app.as_deref().filter(|name| !name.is_empty()) else {
        return crate::system::window::window_inventory_global::list_windows_until(
            filter.focused_only,
            deadline,
        );
    };
    crate::system::window::window_inventory_global::stabilize_global_with(deadline, || {
        crate::system::window::window_inventory_global::capture_validated_with(
            || {
                let owners =
                    crate::system::app::workspace_apps::window_owner_snapshot_until(deadline)?;
                owners.require_match(app_filter)?;
                Ok(owners)
            },
            |owners| owners.matching_pids(app_filter),
            |pids| {
                require_running_app(pids, app_filter)?;
                cg_window::window_records_until(deadline, cg_window::WindowRecordScope::Pids(pids))
            },
            |records, _| {
                let mut windows = windows_from_records_with_focus(
                    records,
                    filter.focused_only,
                    |pid| crate::system::window::window_ax_state::read_until(pid, deadline),
                    crate::system::process::process_identity::matches_instance,
                )?;
                narrow_to_real_windows(&mut windows);
                Ok(windows)
            },
            |before, after, before_pids, records| {
                let after_pids = after.matching_pids(app_filter);
                crate::system::window::window_inventory_global::validate_scoped_snapshot_pair(
                    before,
                    after,
                    before_pids,
                    &after_pids,
                    records,
                )
            },
        )
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn focused_window_until(deadline: Instant) -> Result<Option<WindowInfo>, AdapterError> {
    let Some(pid) = focused_application_pid(deadline)? else {
        return Ok(None);
    };
    let records =
        cg_window::window_records_until(deadline, cg_window::WindowRecordScope::Pid(pid))?;
    let windows = windows_from_records_with_focus(
        records,
        true,
        |owner| crate::system::window::window_ax_state::read_until(owner, deadline),
        crate::system::process::process_identity::matches_instance,
    )?;
    if focused_application_pid(deadline)? != Some(pid) {
        return Err(AdapterError::app_unresponsive(
            "Foreground application changed during focus verification",
        ));
    }
    Ok(windows.into_iter().next())
}

#[cfg(target_os = "macos")]
fn focused_application_pid(deadline: Instant) -> Result<Option<i32>, AdapterError> {
    let system =
        crate::tree::AXElement(unsafe { accessibility_sys::AXUIElementCreateSystemWide() });
    crate::tree::surface_read::element(&system, "AXFocusedApplication", deadline)?
        .map(|app| crate::tree::properties::ax_ipc::pid(&app, deadline))
        .transpose()
        .map_err(|error| crate::system::focus::map_ax_read_error(error, "read focused application"))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn focused_window_until(_deadline: Instant) -> Result<Option<WindowInfo>, AdapterError> {
    Err(AdapterError::not_supported("focused_window"))
}

fn require_running_app(
    pids: &rustc_hash::FxHashSet<i32>,
    app_filter: &str,
) -> Result<(), AdapterError> {
    if !pids.is_empty() {
        return Ok(());
    }
    Err(AdapterError::new(
        agent_desktop_core::ErrorCode::AppNotFound,
        format!("No running application matches '{app_filter}'"),
    )
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
    .with_suggestion("Run 'list-apps' to see running applications, or launch the app first."))
}

fn focus_state(
    ax_state: &mut impl FnMut(
        i32,
    ) -> Result<
        crate::system::window::window_ax_state::WindowAxState,
        AdapterError,
    >,
    pid: i32,
    focused_only: bool,
    has_visible_window: bool,
) -> Result<crate::system::window::window_ax_state::WindowAxState, AdapterError> {
    match ax_state(pid) {
        Ok(state) => Ok(state),
        Err(_) if !focused_only && has_visible_window => {
            Ok(crate::system::window::window_ax_state::WindowAxState {
                focused: None,
                minimized_by_id: rustc_hash::FxHashMap::default(),
                accessible_window_ids: rustc_hash::FxHashSet::default(),
            })
        }
        Err(error) => Err(error),
    }
}

fn visible_window_pids(records: &[cg_window::WindowRecord]) -> rustc_hash::FxHashSet<i32> {
    records
        .iter()
        .filter(|record| record.visible)
        .map(|record| record.pid)
        .collect()
}

fn narrow_to_real_windows(windows: &mut Vec<WindowInfo>) {
    windows.retain(|window| window.state.visible == Some(true) || window.state.minimized.is_some());
}

pub(crate) fn exact_window_for_pid_until(
    pid: i32,
    deadline: Instant,
) -> Result<WindowInfo, AdapterError> {
    let records =
        cg_window::window_records_until(deadline, cg_window::WindowRecordScope::Pid(pid))?;
    let mut windows = windows_from_records_with_focus(
        records,
        false,
        |owner_pid| crate::system::window::window_ax_state::read_until(owner_pid, deadline),
        |owner_pid, instance| {
            crate::system::process::process_identity::matches_instance(owner_pid, instance)
        },
    )?;
    narrow_to_real_windows(&mut windows);
    if windows.len() == 1 {
        return Ok(windows.remove(0));
    }
    let mut focused = windows
        .iter()
        .filter(|window| window.state.is_focused)
        .cloned()
        .collect::<Vec<_>>();
    if focused.len() == 1 {
        return Ok(focused.remove(0));
    }
    if windows.is_empty() {
        return Err(AdapterError::new(
            agent_desktop_core::ErrorCode::WindowNotFound,
            format!("Process {pid} has no visible window"),
        ));
    }
    Err(AdapterError::ambiguous_target(format!(
        "Process {pid} has multiple visible windows and no exact focused window"
    ))
    .with_details(serde_json::json!({
        "candidate_count": windows.len(),
        "candidate_window_ids": windows.iter().map(|window| &window.id).collect::<Vec<_>>(),
    })))
}

fn windows_from_records_with_focus(
    records: Vec<cg_window::WindowRecord>,
    focused_only: bool,
    mut ax_state: impl FnMut(
        i32,
    ) -> Result<
        crate::system::window::window_ax_state::WindowAxState,
        AdapterError,
    >,
    mut verify_instance: impl FnMut(i32, &str) -> Result<bool, AdapterError>,
) -> Result<Vec<WindowInfo>, AdapterError> {
    let candidates = records
        .into_iter()
        .filter(|record| record.window_number > 0)
        .collect::<Vec<_>>();
    let visible_pids = visible_window_pids(&candidates);
    let mut title_counts = std::collections::HashMap::new();
    for record in &candidates {
        *title_counts
            .entry((record.pid, record.display_title().to_owned()))
            .or_insert(0) += 1;
    }

    let mut state_cache = std::collections::HashMap::new();
    let mut windows = Vec::new();
    let mut focused_seen = false;

    for record in candidates {
        let process_instance = record.process_instance.as_deref().ok_or_else(|| {
            identity_race_error(
                record.pid,
                "CoreGraphics record omitted its process instance",
            )
        })?;
        if !verify_instance(record.pid, process_instance)? {
            return Err(identity_race_error(
                record.pid,
                "window owner changed before accessibility focus read",
            ));
        }
        let title_count = title_counts
            .get(&(record.pid, record.display_title().to_owned()))
            .copied()
            .unwrap_or(0);
        let state = match state_cache.entry(record.pid) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => entry.insert(focus_state(
                &mut ax_state,
                record.pid,
                focused_only,
                visible_pids.contains(&record.pid),
            )?),
        };
        if !verify_instance(record.pid, process_instance)? {
            return Err(identity_race_error(
                record.pid,
                "window owner changed after accessibility focus read",
            ));
        }
        let is_focused = !focused_seen
            && matches_focused_window(
                record.display_title(),
                record.window_number,
                &state.focused,
                title_count,
            );
        if focused_only && !is_focused {
            continue;
        }
        focused_seen |= is_focused;
        let minimized = state.minimized_by_id.get(&record.window_number).copied();
        let accessible = state.accessible_window_ids.contains(&record.window_number);
        windows.push(record.into_window_info(is_focused, minimized, accessible)?);
    }

    Ok(windows)
}

#[cfg(test)]
fn matches_app_filter(app_name: &str, app_filter: &str) -> bool {
    app_filter.is_empty() || agent_desktop_core::app_name_matches(app_name, app_filter)
}

fn identity_race_error(pid: i32, phase: &str) -> AdapterError {
    AdapterError::new(
        agent_desktop_core::ErrorCode::AppUnresponsive,
        "Window owner changed while exact window identity was being assembled",
    )
    .with_details(serde_json::json!({
        "kind": "window_identity_race",
        "pid": pid,
        "phase": phase,
        "complete": false,
        "retryable": true,
    }))
}

type FocusedWindowIdentity = Option<(Option<String>, Option<i64>)>;

fn matches_focused_window(
    title: &str,
    window_number: i64,
    identity: &FocusedWindowIdentity,
    same_title_count: usize,
) -> bool {
    let Some((focused_title, focused_number)) = identity else {
        return false;
    };
    if let Some(number) = focused_number {
        return *number == window_number;
    }
    focused_title.as_deref() == Some(title) && same_title_count == 1
}

#[cfg(test)]
#[path = "window_inventory_tests.rs"]
mod tests;
