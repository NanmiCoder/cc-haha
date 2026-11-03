use agent_desktop_core::{
    AdapterError, Deadline, SignalBaseline, SignalCompleteness, SignalFilter,
};

use super::signal_filter_apply::apply_signal_filter;
use super::signal_inventory::{SignalWindowInventory, capture_windows_and_apps};
use super::signal_surfaces::app_scoped_surfaces;
use crate::system::window::listing_retry::narrow_to_permitted_codes;

/// Assembles the `SignalBaseline` `wait --event` diffs, composing the
/// single-pass windows+apps inventory with the app-scoped surface scan under
/// one shared deadline, then deriving `completeness` from whether each pass
/// actually ran to completion rather than from whether any entity was
/// excluded.
///
/// Every failure this function or anything it calls can raise is narrowed to
/// exactly `TIMEOUT` or `APP_UNRESPONSIVE` before it leaves this function,
/// which is the boundary that closes the error set core's poll loop depends
/// on: any other code aborts the whole wait instead of being retried.
pub(crate) fn capture_signal_baseline_impl(
    filter: &SignalFilter,
    deadline: Deadline,
) -> Result<SignalBaseline, AdapterError> {
    deadline
        .ensure_remaining()
        .map_err(narrow_to_permitted_codes)?;
    let inventory = capture_windows_and_apps(deadline).map_err(narrow_to_permitted_codes)?;
    assemble(inventory, filter, deadline)
}

/// The pure-composition half of the capture, separated from the native
/// enumeration so it can be exercised against a hand-built inventory: filter
/// the already-assembled windows and apps, run the app-scoped surface scan
/// only when the filter names a process or an app - core rejects a surface
/// event without `--app` (`wait_mode.rs:168-177`), so an unscoped scan is
/// never requested - and derive `completeness` from whether each pass ran
/// to completion, never from `SignalCompleteness::complete()` unconditionally
/// and never from whether any entity was excluded.
fn assemble(
    inventory: SignalWindowInventory,
    filter: &SignalFilter,
    deadline: Deadline,
) -> Result<SignalBaseline, AdapterError> {
    let inventory = apply_signal_filter(inventory, filter);

    let scan_requested = filter.process.is_some() || filter.app.is_some();
    let surfaces = if scan_requested {
        app_scoped_surfaces(&inventory.apps, deadline).map_err(narrow_to_permitted_codes)?
    } else {
        Vec::new()
    };

    Ok(SignalBaseline {
        windows: inventory.windows,
        apps: inventory.apps,
        surfaces,
        completeness: SignalCompleteness {
            windows: inventory.windows_complete,
            apps: inventory.apps_complete,
            surfaces: scan_requested,
        },
    })
}

#[cfg(test)]
#[path = "signals_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "wait_event_live_tests.rs"]
mod live_event_tests;
