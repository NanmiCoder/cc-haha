use agent_desktop_core::{ActionResult, AdapterError, DeliverySemantics};

use super::action_clock_store as store;

const WINDOW_MS: u64 = 2_000;

/// Whether an action started: anything but one refused before it sent
/// anything. A success that found its state already satisfied delivered
/// nothing.
fn started(result: &Result<ActionResult, AdapterError>) -> bool {
    let disposition = match result {
        Ok(action) => action.disposition(),
        Err(error) => error.disposition,
    };
    disposition != DeliverySemantics::not_delivered()
}

/// Records an action that started against the process it reached, so a wait
/// that targets that process, in another invocation, can tell the action was
/// its. An action that carried no process leaves no record.
pub(crate) fn mark_outcome(target: Option<u32>, result: &Result<ActionResult, AdapterError>) {
    if let Some(pid) = target.filter(|_| started(result)) {
        store::record(pid);
    }
}

/// Whether an action reached this process just now, in this or in another
/// invocation of the tool.
pub(crate) fn recent_for(pid: u32) -> bool {
    store::recent(pid, WINDOW_MS)
}

#[cfg(test)]
#[path = "action_clock_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "action_clock_live_tests.rs"]
mod live_tests;
