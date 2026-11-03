use std::collections::HashMap;

use agent_desktop_core::{
    AdapterError, AppInfo, Deadline, ErrorCode, ProcessId, SnapshotSurface, SurfaceSignal,
};

use crate::system::menu::menu_state;
use crate::system::window::listing_retry::narrow_to_permitted_codes;
use crate::system::window::window_enum::{WindowHandle, enumerate_top_level};
use crate::system::window::window_identity;
use crate::system::window::window_ops::passes_filter;
use crate::tree::automation::root_from_hwnd;
use crate::tree::surfaces::window_is_modal_sheet;

/// The identity a surface needs to be reported: the pieces of an already
/// filtered [`AppInfo`] that a `SurfaceSignal` actually carries, borrowed
/// rather than cloned until a surface is actually found for it.
struct SurfaceTarget<'a> {
    pid: ProcessId,
    name: &'a str,
    instance: &'a str,
}

/// `SurfaceSignal`s for every process named in `apps`, scoped to exactly
/// those processes.
///
/// Core rejects `surface-appeared` / `surface-dismissed` without `--app`
/// (`wait_mode.rs:168-177`), so this is only ever called with a filtered,
/// non-empty app population — never a desktop-wide walk. Each app in `apps`
/// contributes at most one `Menu` signal (the predicate is a per-process
/// boolean) and zero or more `Sheet` signals (one per modal owned window).
///
/// An app whose `process_instance` is `None` is skipped rather than
/// producing a surface with a fabricated instance: `signal_inventory`
/// already excludes such entries, so this is a defensive backstop, not the
/// primary enforcement of that rule.
pub(crate) fn app_scoped_surfaces(
    apps: &[AppInfo],
    deadline: Deadline,
) -> Result<Vec<SurfaceSignal>, AdapterError> {
    deadline.ensure_remaining()?;
    let targets = identified_targets(apps);
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let mut surfaces = sheet_surfaces(&targets, deadline)?;
    let pids: Vec<ProcessId> = targets.values().map(|target| target.pid).collect();
    let menus_open = menu_state::menus_open_for(&pids, deadline)?;
    for target in targets.values() {
        if menus_open.get(&target.pid).copied().unwrap_or(false) {
            surfaces.push(menu_signal(target));
        }
    }
    Ok(surfaces)
}

fn identified_targets(apps: &[AppInfo]) -> HashMap<ProcessId, SurfaceTarget<'_>> {
    apps.iter()
        .filter_map(|app| {
            let instance = app.process_instance.as_deref()?;
            Some((
                app.pid,
                SurfaceTarget {
                    pid: app.pid,
                    name: app.name.as_str(),
                    instance,
                },
            ))
        })
        .collect()
}

/// The surface kinds the baseline can emit - the two constructors below are
/// the only places a `SurfaceSignal` is built in this adapter, so this list
/// is what "a signal emitted implies the surface advertised" is asserted
/// against. A new signal constructor must join it, and the advertised set
/// must contain it, in the same commit.
#[cfg(test)]
pub(crate) const SIGNAL_SURFACE_KINDS: &[SnapshotSurface] =
    &[SnapshotSurface::Menu, SnapshotSurface::Sheet];

fn menu_signal(target: &SurfaceTarget<'_>) -> SurfaceSignal {
    SurfaceSignal {
        kind: SnapshotSurface::Menu,
        app: target.name.to_string(),
        pid: target.pid,
        process_instance: target.instance.to_string(),
        id: format!("menu-{}", u32::from(target.pid)),
        title: None,
    }
}

fn sheet_signal(target: &SurfaceTarget<'_>, handle: WindowHandle) -> SurfaceSignal {
    SurfaceSignal {
        kind: SnapshotSurface::Sheet,
        app: target.name.to_string(),
        pid: target.pid,
        process_instance: target.instance.to_string(),
        id: crate::system::window::window_ops::window_id(handle),
        title: None,
    }
}

/// One top-level scan, shared across every target pid in `targets`, so a
/// filter naming several processes still costs a single `EnumWindows` walk
/// rather than one per process.
///
/// A candidate window is admitted the same way the ordinary window inventory
/// admits one (`passes_filter`) plus carrying an owner — the "owned window"
/// half of the measured modal signature. `window_is_modal_sheet` supplies the
/// other half, so the signal path and `snapshot --surface sheet` agree about
/// what a sheet is.
#[cfg(target_os = "windows")]
fn sheet_surfaces(
    targets: &HashMap<ProcessId, SurfaceTarget<'_>>,
    deadline: Deadline,
) -> Result<Vec<SurfaceSignal>, AdapterError> {
    deadline.ensure_remaining()?;
    let mut candidates = Vec::new();
    enumerate_top_level(|window| {
        if passes_filter(&window) && has_owner(window.handle) {
            candidates.push(window.handle);
        }
        true
    })
    .map_err(narrow_to_permitted_codes)?;

    let mut surfaces = Vec::new();
    for (index, handle) in candidates.into_iter().enumerate() {
        if index > 0 {
            deadline.ensure_remaining()?;
        }
        let Some(pid) = window_identity::live_window_owner(handle) else {
            continue;
        };
        let Some(target) = targets.get(&pid) else {
            continue;
        };
        match root_from_hwnd(handle as isize, deadline) {
            Ok(root) if window_is_modal_sheet(&root) => {
                surfaces.push(sheet_signal(target, handle));
            }
            Ok(_) => {}
            Err(error) if error.code == ErrorCode::WindowNotFound => {}
            Err(error) => return Err(narrow_to_permitted_codes(error)),
        }
    }
    Ok(surfaces)
}

#[cfg(not(target_os = "windows"))]
fn sheet_surfaces(
    _targets: &HashMap<ProcessId, SurfaceTarget<'_>>,
    deadline: Deadline,
) -> Result<Vec<SurfaceSignal>, AdapterError> {
    deadline.ensure_remaining()?;
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
fn has_owner(handle: WindowHandle) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GET_WINDOW_CMD, GW_OWNER, GetWindow};

    let command: GET_WINDOW_CMD = GW_OWNER;
    !unsafe { GetWindow(handle, command) }.is_null()
}

#[cfg(test)]
#[path = "signal_surfaces_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "wait_surface_live_tests.rs"]
mod live_surface_tests;
