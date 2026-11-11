use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, NotificationFilter};

use super::list::NotificationEntry;

const REOBSERVATION_INTERVAL: Duration = Duration::from_millis(25);
const STRATEGY_SETTLE_TIME: Duration = Duration::from_millis(250);

#[cfg(test)]
#[path = "dismiss_verify_tests.rs"]
mod tests;

pub(super) fn disappeared(
    original: &NotificationEntry,
    filter: &NotificationFilter,
    matching_before: usize,
    pid: i32,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let settle_deadline = deadline.capped(STRATEGY_SETTLE_TIME);
    let result = wait_with(
        || {
            let current = super::list::list_entries(filter, pid, settle_deadline)?;
            Ok(matching_count(&current, original) >= matching_before)
        },
        settle_deadline,
    );
    match result {
        Err(error) if error.code == ErrorCode::Timeout && !deadline.is_expired() => Ok(false),
        other => other,
    }
}

pub(super) fn verified_after_strategy(
    outcome: Result<bool, AdapterError>,
    deadline: Deadline,
    verify: impl FnOnce() -> Result<bool, AdapterError>,
) -> Result<bool, AdapterError> {
    if let Err(error) = outcome {
        super::read::tolerate_ax_strategy_error(error, deadline)?;
    }
    verify()
}

fn wait_with(
    mut is_present: impl FnMut() -> Result<bool, AdapterError>,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    loop {
        if !is_present()? {
            return Ok(true);
        }
        std::thread::sleep(deadline.remaining_slice(REOBSERVATION_INTERVAL)?);
    }
}

pub(super) fn matching_count(entries: &[NotificationEntry], original: &NotificationEntry) -> usize {
    entries
        .iter()
        .filter(|current| matches(original, current))
        .count()
}

pub(super) fn matches(original: &NotificationEntry, current: &NotificationEntry) -> bool {
    same_info(&original.info, &current.info)
}

fn same_info(
    original: &agent_desktop_core::NotificationInfo,
    current: &agent_desktop_core::NotificationInfo,
) -> bool {
    original.app_name == current.app_name
        && original.title == current.title
        && original.body == current.body
}
