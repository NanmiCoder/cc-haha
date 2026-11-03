use std::collections::HashMap;

use agent_desktop_core::{AdapterError, Deadline, ProcessId};

/// [`super::menu_is_open`] for every pid in `pids`, sharing one classic-source
/// `TH32CS_SNAPTHREAD` snapshot across all of them instead of the one
/// snapshot per pid that calling [`super::menu_is_open`] in a loop would
/// take. The snapshot enumerates every thread on the desktop regardless of
/// which pid is asked about, so a multi-pid caller pays for that walk once.
/// Each pid then gets the same per-pid composition [`super::menu_is_open`]
/// applies, in the same short-circuit order: the source-B tool-window probe
/// only when the shared classic read did not already resolve the pid true,
/// and the source-C Chromium probe only when source B did not fire either -
/// so every per-pid result is identical to what calling
/// [`super::menu_is_open`] on that pid alone would have produced, Chromium
/// DOM menus included.
#[cfg(target_os = "windows")]
pub(crate) fn menus_open_for(
    pids: &[ProcessId],
    deadline: Deadline,
) -> Result<HashMap<ProcessId, bool>, AdapterError> {
    deadline.ensure_remaining()?;
    for &pid in pids {
        super::ensure_process_exists(pid)?;
    }
    deadline.ensure_remaining()?;
    let mut results = classic_menu_mode_for_many(pids, deadline)?;
    for &pid in pids {
        if results.get(&pid).copied().unwrap_or(false) {
            continue;
        }
        deadline.ensure_remaining()?;
        if super::uia_menu_reachable(pid, deadline)? {
            results.insert(pid, true);
            continue;
        }
        deadline.ensure_remaining()?;
        let chromium = super::chromium_dom_menu_reachable(pid, deadline)?;
        results.insert(pid, chromium);
    }
    Ok(results)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn menus_open_for(
    pids: &[ProcessId],
    deadline: Deadline,
) -> Result<HashMap<ProcessId, bool>, AdapterError> {
    deadline.ensure_remaining()?;
    Ok(pids.iter().map(|&pid| (pid, false)).collect())
}

/// The multi-pid form of the classic source: one `TH32CS_SNAPTHREAD`
/// snapshot, walked once by [`crate::system::runtime::thread_walk::walk_gui_threads`],
/// with each thread's owner tested against every pid in `pids` rather than
/// one snapshot walk per pid. `GetGUIThreadInfo` is still read per thread
/// through the same [`super::thread_reports_menu_mode`] the single-pid
/// source uses; only the snapshot enumeration is shared. The walk never
/// short-circuits here - every thread on the desktop still owes a look,
/// since a later thread could belong to a pid this walk has not yet
/// resolved true.
#[cfg(target_os = "windows")]
fn classic_menu_mode_for_many(
    pids: &[ProcessId],
    deadline: Deadline,
) -> Result<HashMap<ProcessId, bool>, AdapterError> {
    let mut found: HashMap<ProcessId, bool> = pids.iter().map(|&pid| (pid, false)).collect();
    crate::system::runtime::thread_walk::walk_gui_threads(deadline, |entry| {
        if let Some(slot) = found.get_mut(&ProcessId::from(entry.th32OwnerProcessID)) {
            if !*slot && super::thread_reports_menu_mode(entry.th32ThreadID) {
                *slot = true;
            }
        }
        None::<()>
    })?;
    Ok(found)
}
