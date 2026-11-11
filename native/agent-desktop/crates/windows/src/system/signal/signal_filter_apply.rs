use agent_desktop_core::{ProcessId, SignalFilter};

use super::signal_inventory::SignalWindowInventory;

/// Applies `SignalFilter` to an already-assembled `SignalWindowInventory`.
///
/// The filter intersects rather than alternates: when `filter.process` is
/// set, only entities carrying that exact pid and `process_instance` survive;
/// when `filter.app` is also set, entities must additionally match the app
/// name. The caller sets both fields on every wait that is not itself
/// waiting for a launch, and two Windows processes routinely share one image
/// name, so matching by name alone would return every pid sharing that name
/// and make the caller's own process-identity check fail with a
/// non-retryable stale-reference error. Intersecting keeps every returned
/// entity's identity provably exact, which is what that check requires.
///
/// Filtering runs after assembly, over entities whose identity is already
/// resolved, so `windows_complete` and `apps_complete` travel through
/// unchanged: neither reflects what the filter removed, only what the walk
/// itself could not identify.
pub(crate) fn apply_signal_filter(
    inventory: SignalWindowInventory,
    filter: &SignalFilter,
) -> SignalWindowInventory {
    let SignalWindowInventory {
        windows,
        apps,
        windows_complete,
        apps_complete,
    } = inventory;

    let windows = windows
        .into_iter()
        .filter(|window| {
            matches_filter(
                filter,
                window.pid,
                window.process_instance.as_deref(),
                &window.app,
            )
        })
        .collect();
    let apps = apps
        .into_iter()
        .filter(|app| matches_filter(filter, app.pid, app.process_instance.as_deref(), &app.name))
        .collect();

    SignalWindowInventory {
        windows,
        apps,
        windows_complete,
        apps_complete,
    }
}

/// An entity survives only if it satisfies every condition the filter
/// actually sets, so a filter naming only a process behaves like a pure
/// process filter and a filter naming only an app behaves like a pure app
/// filter, while a filter naming both requires each entity to pass both.
///
/// The app comparison is exact and case-insensitive over the process image
/// name - the same predicate the crate's own app-name lookup applies by
/// default - never the substring match the ordinary window listing applies
/// to its own app filter.
fn matches_filter(
    filter: &SignalFilter,
    pid: ProcessId,
    process_instance: Option<&str>,
    app_name: &str,
) -> bool {
    let process_matches = filter.process.as_ref().is_none_or(|expected| {
        pid == expected.pid && process_instance == Some(expected.instance.as_str())
    });
    let app_matches = filter
        .app
        .as_deref()
        .is_none_or(|expected_name| app_name.eq_ignore_ascii_case(expected_name));
    process_matches && app_matches
}

#[cfg(test)]
#[path = "signal_filter_apply_tests.rs"]
mod tests;
