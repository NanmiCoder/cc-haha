use crate::system::{window::cg_window::WindowRecord, window::window_ax_state::WindowAxState};
use agent_desktop_core::{AdapterError, ErrorCode, WindowInfo};
use rustc_hash::{FxHashMap, FxHashSet};
use std::time::Instant;

impl OwnerSnapshotView for crate::system::app::workspace_apps::WindowOwnerSnapshot {
    fn eligible_pids(&self) -> FxHashSet<i32> {
        crate::system::app::workspace_apps::WindowOwnerSnapshot::eligible_pids(self)
    }

    fn generation(&self, pid: i32) -> Option<OwnerGeneration> {
        self.owner(pid).map(|owner| match owner.launch_time {
            Some(launch_time) => OwnerGeneration::LaunchTime(launch_time),
            None => OwnerGeneration::LiveProcess,
        })
    }

    fn frontmost_pid(&self) -> Option<i32> {
        self.frontmost().map(|owner| owner.pid)
    }

    fn same_generation(&self, other: &Self) -> bool {
        crate::system::app::workspace_apps::WindowOwnerSnapshot::same_generation(self, other)
    }
}

pub(in crate::system) trait OwnerSnapshotView {
    fn eligible_pids(&self) -> FxHashSet<i32>;
    fn generation(&self, pid: i32) -> Option<OwnerGeneration>;
    fn frontmost_pid(&self) -> Option<i32>;
    fn same_generation(&self, other: &Self) -> bool;
}

#[derive(Clone, Copy, PartialEq)]
pub(in crate::system) enum OwnerGeneration {
    LaunchTime(f64),
    LiveProcess,
}

pub(crate) fn list_windows_until(
    focused_only: bool,
    deadline: Instant,
) -> Result<Vec<WindowInfo>, AdapterError> {
    stabilize_global_with(deadline, || capture_global_once(focused_only, deadline))
}

fn capture_global_once(
    focused_only: bool,
    deadline: Instant,
) -> Result<Vec<WindowInfo>, AdapterError> {
    let mut windows = capture_global_with(
        focused_only,
        || crate::system::app::workspace_apps::window_owner_snapshot_until(deadline),
        |eligible_pids| {
            crate::system::window::cg_window::window_records_until(
                deadline,
                crate::system::window::cg_window::WindowRecordScope::Pids(eligible_pids),
            )
        },
        |pid| crate::system::window::window_ax_state::read_frontmost_until(pid, deadline),
    )?;
    crate::system::window::window_ax_state::label_accessibility(&mut windows, |pid| {
        let probe_deadline = Instant::now()
            .checked_add(std::time::Duration::from_millis(50))
            .map_or(deadline, |probe| probe.min(deadline));
        crate::system::window::window_ax_state::accessible_window_ids_until(pid, probe_deadline)
    });
    Ok(windows)
}

fn capture_global_with<S: OwnerSnapshotView>(
    focused_only: bool,
    capture_owners: impl FnMut() -> Result<S, AdapterError>,
    capture_records: impl FnMut(&FxHashSet<i32>) -> Result<Vec<WindowRecord>, AdapterError>,
    mut read_frontmost: impl FnMut(i32) -> Result<WindowAxState, AdapterError>,
) -> Result<Vec<WindowInfo>, AdapterError> {
    capture_stable_with(
        capture_owners,
        OwnerSnapshotView::eligible_pids,
        capture_records,
        |records, owners| {
            assemble_global_windows(records, owners, focused_only, &mut read_frontmost)
        },
    )
}

pub(in crate::system) fn capture_stable_with<S: OwnerSnapshotView>(
    capture_owners: impl FnMut() -> Result<S, AdapterError>,
    select_pids: impl FnMut(&S) -> FxHashSet<i32>,
    capture_records: impl FnMut(&FxHashSet<i32>) -> Result<Vec<WindowRecord>, AdapterError>,
    assemble: impl FnMut(Vec<WindowRecord>, &S) -> Result<Vec<WindowInfo>, AdapterError>,
) -> Result<Vec<WindowInfo>, AdapterError> {
    capture_validated_with(
        capture_owners,
        select_pids,
        capture_records,
        assemble,
        |before, after, _, records| validate_snapshot_pair(before, after, records),
    )
}

pub(in crate::system) fn capture_validated_with<S: OwnerSnapshotView>(
    mut capture_owners: impl FnMut() -> Result<S, AdapterError>,
    mut select_pids: impl FnMut(&S) -> FxHashSet<i32>,
    mut capture_records: impl FnMut(&FxHashSet<i32>) -> Result<Vec<WindowRecord>, AdapterError>,
    mut assemble: impl FnMut(Vec<WindowRecord>, &S) -> Result<Vec<WindowInfo>, AdapterError>,
    mut validate: impl FnMut(&S, &S, &FxHashSet<i32>, &[WindowRecord]) -> Result<(), AdapterError>,
) -> Result<Vec<WindowInfo>, AdapterError> {
    let before = capture_owners()?;
    let eligible_pids = select_pids(&before);
    let records = capture_records(&eligible_pids)?;
    let assembled = assemble(records.clone(), &before);
    let after = capture_owners()?;
    validate(&before, &after, &eligible_pids, &records)?;
    assembled
}

pub(in crate::system) fn assemble_global_windows<S: OwnerSnapshotView>(
    records: Vec<WindowRecord>,
    owners: &S,
    focused_only: bool,
    mut read_frontmost: impl FnMut(i32) -> Result<WindowAxState, AdapterError>,
) -> Result<Vec<WindowInfo>, AdapterError> {
    let records = records
        .into_iter()
        .filter(|record| record.window_number > 0)
        .collect::<Vec<_>>();
    validate_record_generations(&records, owners)?;
    let frontmost_pid = owners.frontmost_pid();
    let frontmost_window_owner =
        frontmost_pid.filter(|pid| records.iter().any(|record| record.pid == *pid));
    let focus_state = match frontmost_window_owner {
        Some(pid) => Some(read_frontmost(pid).map_err(frontmost_read_error)?),
        None => None,
    };
    let focus_reported = focus_state
        .as_ref()
        .is_some_and(|state| state.focused.is_some());
    let focused_window = match matching_focus_windows(&records, frontmost_pid, focus_state.as_ref())
    {
        FocusJoin::TitleAmbiguous => None,
        FocusJoin::Windows(windows) => {
            if frontmost_window_owner.is_some() && focus_reported && windows.len() != 1 {
                return Err(focus_join_error(frontmost_pid, windows.len()));
            }
            windows.first().copied()
        }
    };
    records
        .into_iter()
        .filter_map(|record| {
            let is_focused = Some((record.pid, record.window_number)) == focused_window;
            if focused_only && !is_focused {
                return None;
            }
            let minimized = if Some(record.pid) == frontmost_pid {
                focus_state
                    .as_ref()
                    .and_then(|state| state.minimized_by_id.get(&record.window_number).copied())
            } else {
                None
            };
            Some(record.into_window_info(is_focused, minimized, true))
        })
        .collect::<Result<Vec<_>, _>>()
}

pub(in crate::system) fn validate_snapshot_pair<S: OwnerSnapshotView>(
    before: &S,
    after: &S,
    records: &[WindowRecord],
) -> Result<(), AdapterError> {
    if !before.same_generation(after) {
        return Err(owner_churn_error(None, "appkit_snapshot_changed"));
    }
    validate_record_generations(records, after)
}

pub(in crate::system) fn validate_scoped_snapshot_pair<S: OwnerSnapshotView>(
    before: &S,
    after: &S,
    before_pids: &FxHashSet<i32>,
    after_pids: &FxHashSet<i32>,
    records: &[WindowRecord],
) -> Result<(), AdapterError> {
    if before_pids != after_pids
        || before_pids
            .iter()
            .any(|pid| before.generation(*pid) != after.generation(*pid))
    {
        return Err(owner_churn_error(None, "selected_appkit_snapshot_changed"));
    }
    validate_record_generations(records, after)
}

pub(in crate::system) fn stabilize_global_with(
    deadline: Instant,
    mut capture: impl FnMut() -> Result<Vec<WindowInfo>, AdapterError>,
) -> Result<Vec<WindowInfo>, AdapterError> {
    let mut attempts = 0_u64;
    let mut last_error = None;
    loop {
        if Instant::now() >= deadline {
            return Err(global_timeout(attempts, last_error.as_ref()));
        }
        attempts += 1;
        match capture() {
            Ok(windows) => return Ok(windows),
            Err(error) if retryable_global_error(&error) => {
                last_error = Some(error);
            }
            Err(error) if error.code == ErrorCode::Timeout && last_error.is_some() => {
                return Err(global_timeout(attempts, last_error.as_ref()));
            }
            Err(error) => return Err(error),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            std::thread::sleep(remaining.min(std::time::Duration::from_millis(5)));
        }
    }
}

fn validate_record_generations<S: OwnerSnapshotView>(
    records: &[WindowRecord],
    owners: &S,
) -> Result<(), AdapterError> {
    for (pid, instance) in unique_process_instances(records)? {
        let generation = owners
            .generation(pid)
            .ok_or_else(|| owner_churn_error(Some(pid), "owner_not_eligible"))?;
        let matches = match generation {
            OwnerGeneration::LaunchTime(launch_time) => {
                crate::system::process::process_identity::instance_matches_launch_time(
                    pid,
                    instance,
                    launch_time,
                )?
            }
            OwnerGeneration::LiveProcess => {
                crate::system::process::process_identity::matches_instance(pid, instance)?
            }
        };
        if !matches {
            return Err(owner_churn_error(Some(pid), "process_generation_changed"));
        }
    }
    Ok(())
}

fn unique_process_instances(records: &[WindowRecord]) -> Result<Vec<(i32, &str)>, AdapterError> {
    let mut instances = FxHashMap::default();
    for record in records {
        let instance = record
            .process_instance
            .as_deref()
            .filter(|instance| !instance.is_empty())
            .ok_or_else(|| owner_churn_error(Some(record.pid), "process_instance_missing"))?;
        match instances.entry(record.pid) {
            std::collections::hash_map::Entry::Occupied(entry) => {
                if *entry.get() != instance {
                    return Err(owner_churn_error(
                        Some(record.pid),
                        "process_instance_conflict",
                    ));
                }
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(instance);
            }
        }
    }
    let mut instances = instances.into_iter().collect::<Vec<_>>();
    instances.sort_unstable_by_key(|(pid, _)| *pid);
    Ok(instances)
}

enum FocusJoin {
    Windows(Vec<(i32, i64)>),
    TitleAmbiguous,
}

fn matching_focus_windows(
    records: &[WindowRecord],
    frontmost_pid: Option<i32>,
    state: Option<&WindowAxState>,
) -> FocusJoin {
    let Some(frontmost_pid) = frontmost_pid else {
        return FocusJoin::Windows(Vec::new());
    };
    let Some((focused_title, focused_number)) = state.and_then(|state| state.focused.as_ref())
    else {
        return FocusJoin::Windows(Vec::new());
    };
    if let Some(number) = focused_number {
        return FocusJoin::Windows(
            records
                .iter()
                .filter(|record| record.pid == frontmost_pid && record.window_number == *number)
                .map(|record| (record.pid, record.window_number))
                .collect(),
        );
    }
    let title_matches = records
        .iter()
        .filter(|record| {
            record.pid == frontmost_pid && focused_title.as_deref() == Some(record.display_title())
        })
        .map(|record| (record.pid, record.window_number))
        .collect::<Vec<_>>();
    if title_matches.len() > 1 {
        return FocusJoin::TitleAmbiguous;
    }
    FocusJoin::Windows(title_matches)
}

fn frontmost_read_error(error: AdapterError) -> AdapterError {
    if !matches!(
        error.code,
        ErrorCode::Timeout | ErrorCode::AppUnresponsive | ErrorCode::ElementNotFound
    ) {
        return error;
    }
    let source_kind = error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .cloned();
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Authoritative frontmost window accessibility read was incomplete",
    )
    .with_details(serde_json::json!({
        "kind": "frontmost_window_ax_incomplete",
        "source_code": error.code.as_str(),
        "source_kind": source_kind,
        "complete": false,
        "retryable": true,
    }))
}

fn focus_join_error(pid: Option<i32>, match_count: usize) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Authoritative frontmost app did not join to one exact window",
    )
    .with_details(serde_json::json!({
        "kind": "frontmost_window_join",
        "pid": pid,
        "match_count": match_count,
        "complete": false,
        "retryable": true,
    }))
}

fn owner_churn_error(pid: Option<i32>, phase: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Window owner identity changed during global inventory",
    )
    .with_details(serde_json::json!({
        "kind": "global_window_owner_churn",
        "pid": pid,
        "phase": phase,
        "complete": false,
        "retryable": true,
    }))
}

fn retryable_global_error(error: &AdapterError) -> bool {
    error.code == ErrorCode::AppUnresponsive && error.is_explicitly_retryable()
}

#[path = "window_inventory_global_timeout.rs"]
mod timeout;
use timeout::global_timeout;

#[cfg(test)]
#[path = "window_inventory_global_timeout_tests.rs"]
mod timeout_tests;

#[cfg(test)]
#[path = "window_inventory_global_tests.rs"]
mod tests;
