use std::collections::{HashMap, HashSet};

use agent_desktop_core::{
    AdapterError, AppInfo, AppPresentation, Deadline, ErrorCode, ProcessId, WindowInfo,
};

use crate::system::app_ops;
use crate::system::process_identity;
use crate::system::window::listing_retry::{LISTING_RACE_ATTEMPTS, retry_transient_window_race};
use crate::system::window::window_enum::{EnumeratedWindow, enumerate_top_level};
use crate::system::window::window_identity;
use crate::system::window::window_ops;

/// One coherent instant's windows and apps, assembled from a single
/// `EnumWindows` pass plus one `ToolHelp` process snapshot.
///
/// `windows_complete` / `apps_complete` report whether the walk ran to
/// completion, never whether every entity was identifiable.
#[derive(Debug, Clone)]
pub(crate) struct SignalWindowInventory {
    pub(crate) windows: Vec<WindowInfo>,
    pub(crate) apps: Vec<AppInfo>,
    pub(crate) windows_complete: bool,
    pub(crate) apps_complete: bool,
}

impl SignalWindowInventory {
    fn truncated() -> Self {
        Self {
            windows: Vec::new(),
            apps: Vec::new(),
            windows_complete: false,
            apps_complete: false,
        }
    }
}

struct WalkEntry {
    window: EnumeratedWindow,
    pid: ProcessId,
    token: Option<String>,
}

enum PassOutcome {
    Coherent(SignalWindowInventory),
    Truncated,
}

/// The single-pass, mutually-coherent windows+apps observation `wait --event`
/// polls. A mid-walk identity race is absorbed internally by the shared
/// listing-retry helper, because surfacing it would abort the whole wait:
/// core retries only `TIMEOUT`, `ELEMENT_NOT_FOUND` and `APP_UNRESPONSIVE`. A
/// truncated walk is reported rather than retried, since retrying it would
/// spend the same exhausted budget again.
pub(crate) fn capture_windows_and_apps(
    deadline: Deadline,
) -> Result<SignalWindowInventory, AdapterError> {
    match retry_transient_window_race(deadline, is_mid_walk_race, || single_pass(deadline)) {
        Ok(PassOutcome::Coherent(inventory)) => Ok(inventory),
        Ok(PassOutcome::Truncated) => Ok(SignalWindowInventory::truncated()),
        Err(error) if is_mid_walk_race(&error) => {
            Err(mid_walk_identity_race_error(LISTING_RACE_ATTEMPTS))
        }
        Err(error) => Err(error),
    }
}

/// `WINDOW_NOT_FOUND` is otherwise never produced on this path -
/// `remap_native_failure` never yields it and neither does
/// `process_identity::token_for_pid` - so it is an unambiguous internal
/// race marker the shared retry helper can classify without a bespoke type.
fn is_mid_walk_race(error: &AdapterError) -> bool {
    error.code == ErrorCode::WindowNotFound
}

fn mid_walk_race_signal() -> AdapterError {
    AdapterError::new(
        ErrorCode::WindowNotFound,
        "internal: mid-walk identity race",
    )
}

fn single_pass(deadline: Deadline) -> Result<PassOutcome, AdapterError> {
    #[cfg(test)]
    enum_windows_calls::record();

    let mut candidates = Vec::new();
    let mut truncated = false;
    enumerate_top_level(|window| {
        if !walk_budget_ok(deadline) {
            truncated = true;
            return false;
        }
        if window_ops::passes_filter(&window) {
            candidates.push(window);
        }
        true
    })
    .map_err(remap_native_failure)?;

    if truncated {
        return Ok(PassOutcome::Truncated);
    }

    #[cfg(all(test, target_os = "windows"))]
    if force_race::consume_if_armed() {
        return Err(mid_walk_race_signal());
    }

    let walk_entries = walk_phase(candidates, deadline)?;
    assembly_phase(walk_entries, deadline)
}

fn walk_budget_ok(deadline: Deadline) -> bool {
    #[cfg(all(test, target_os = "windows"))]
    if force_truncation::is_active() {
        return false;
    }
    deadline.ensure_remaining().is_ok()
}

/// Reads each admitted window's owning pid and process-generation token once
/// per distinct pid, so a process owning many windows costs one token read.
/// A pid that cannot be determined this early means the window has already
/// vanished, not that its identity is permission-blocked, so it is dropped
/// uncounted rather than counted as an identity exclusion; the counted ones are
/// the token and image-name reads, both applied in `assembly_phase`.
fn walk_phase(
    candidates: Vec<EnumeratedWindow>,
    deadline: Deadline,
) -> Result<Vec<WalkEntry>, AdapterError> {
    let mut cache: HashMap<ProcessId, Option<String>> = HashMap::new();
    let mut entries = Vec::new();
    for (index, window) in candidates.into_iter().enumerate() {
        if index > 0 {
            deadline.ensure_remaining()?;
        }
        let Some(pid) = window_identity::live_window_owner(window.handle) else {
            continue;
        };
        let token = cached_token(&mut cache, pid)?;
        entries.push(WalkEntry { window, pid, token });
    }
    Ok(entries)
}

/// Re-verifies every walk-phase entry against a fresh read and folds in the
/// one `ToolHelp` snapshot for image names.
///
/// Three outcomes, deliberately not the same disposition: a handle that no
/// longer resolves to any pid has simply closed since the walk and is
/// dropped uncounted - its absence is the truth, not an approximation of it.
/// A pid resolving to a *different* identity - a different pid, or the same
/// pid with a different generation token - is the race this pass re-walks for.
/// A token unreadable on both reads is a deterministic exclusion: counted, and
/// never emitted as `None`, which the diff drops and a filtered wait aborts on.
fn assembly_phase(
    entries: Vec<WalkEntry>,
    deadline: Deadline,
) -> Result<PassOutcome, AdapterError> {
    deadline.ensure_remaining()?;
    let snapshot = app_ops::process_snapshot().map_err(remap_native_failure)?;
    let name_by_pid: HashMap<ProcessId, String> = snapshot
        .into_iter()
        .map(|row| (row.pid, row.name))
        .collect();

    let mut cache: HashMap<ProcessId, Option<String>> = HashMap::new();
    let mut windows = Vec::new();
    let mut apps = Vec::new();
    let mut apps_seen: HashSet<ProcessId> = HashSet::new();
    let mut focused_seen = false;

    for (index, entry) in entries.into_iter().enumerate() {
        if index > 0 {
            deadline.ensure_remaining()?;
        }
        let Some(current_pid) = window_identity::live_window_owner(entry.window.handle) else {
            continue;
        };
        if current_pid != entry.pid {
            return Err(mid_walk_race_signal());
        }
        let fresh_token = cached_token(&mut cache, current_pid)?;
        let token = match (entry.token.as_deref(), fresh_token.as_deref()) {
            (None, None) => continue,
            (Some(walk_token), Some(assembly_token)) if walk_token == assembly_token => {
                walk_token.to_string()
            }
            _ => return Err(mid_walk_race_signal()),
        };
        let Some(app_name) = name_by_pid.get(&current_pid).cloned() else {
            continue;
        };

        let focused = !focused_seen && window_ops::is_foreground_window(entry.window.handle);
        focused_seen |= focused;
        windows.push(WindowInfo {
            id: window_ops::window_id(entry.window.handle),
            title: window_identity::live_window_title(entry.window.handle).unwrap_or_default(),
            app: app_name.clone(),
            pid: current_pid,
            process_instance: Some(token.clone()),
            bounds: Some(entry.window.rect),
            state: window_ops::window_state(focused, entry.window.iconic, entry.window.visible),
        });
        if apps_seen.insert(current_pid) {
            apps.push(AppInfo {
                name: app_name,
                pid: current_pid,
                bundle_id: None,
                process_instance: Some(token),
                presentation: Some(AppPresentation::Foreground),
            });
        }
    }
    apps.sort_by(|left, right| left.name.cmp(&right.name));

    Ok(PassOutcome::Coherent(SignalWindowInventory {
        windows,
        apps,
        windows_complete: true,
        apps_complete: true,
    }))
}

fn cached_token(
    cache: &mut HashMap<ProcessId, Option<String>>,
    pid: ProcessId,
) -> Result<Option<String>, AdapterError> {
    if let Some(cached) = cache.get(&pid) {
        return Ok(cached.clone());
    }
    let token = token_for_pid_seamed(pid)?;
    cache.insert(pid, token.clone());
    Ok(token)
}

fn token_for_pid_seamed(pid: ProcessId) -> Result<Option<String>, AdapterError> {
    #[cfg(test)]
    if force_token_none::matches(pid) {
        return Ok(None);
    }
    process_identity::token_for_pid(pid)
}

/// Narrows any native-call failure onto the closed error set. `TIMEOUT`
/// passes through unchanged; everything else - `EnumWindows` or `ToolHelp`
/// reporting `INTERNAL` - becomes `APP_UNRESPONSIVE`, since the caller
/// treats both as "the desktop could not be read right now, try again."
fn remap_native_failure(error: AdapterError) -> AdapterError {
    if error.code == ErrorCode::Timeout {
        return error;
    }
    let mut mapped = AdapterError::new(ErrorCode::AppUnresponsive, error.message.clone())
        .with_details(serde_json::json!({ "kind": "native_enumeration_failure" }));
    if let Some(detail) = error.platform_detail.as_deref() {
        mapped = mapped.with_platform_detail(detail.to_string());
    }
    mapped
}

fn mid_walk_identity_race_error(attempts: u32) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Window identity was inconsistent across every re-walk attempt",
    )
    .with_details(serde_json::json!({
        "kind": "mid_walk_identity_race",
        "attempts": attempts,
    }))
}

#[path = "signal_inventory_test_seams.rs"]
mod test_seams;
#[cfg(test)]
use test_seams::{enum_windows_calls, force_token_none};
#[cfg(all(test, target_os = "windows"))]
use test_seams::{force_race, force_truncation};

#[cfg(test)]
#[path = "signal_inventory_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "signal_inventory_command_live_tests.rs"]
mod command_live_tests;
