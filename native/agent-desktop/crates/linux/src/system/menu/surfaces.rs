use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ProcessIdentity, SurfaceInfo, WindowInfo,
};

use super::inventory::scan_windows;
use super::inventory_reader::Inventory;
use super::menu_surface;
use super::surface_scan::NestedScan;
use crate::system::SharedBus;
use crate::system::process::process_facts;
use crate::system::process::unresponsive::scoped_windows_of;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::registry::read_registry_for;

fn require_same_process(process: &ProcessIdentity) -> Result<(), AdapterError> {
    let Some(facts) = process_facts::read(process.pid.get()) else {
        return Err(AdapterError::new(
            ErrorCode::AppNotFound,
            "The process is no longer running",
        ));
    };
    if facts.instance != process.instance {
        return Err(AdapterError::new(
            ErrorCode::AppNotFound,
            "The process id was reused by another process",
        )
        .with_suggestion("List the applications again"));
    }
    Ok(())
}

fn surface(id: &str, kind: &str, title: &Option<String>) -> SurfaceInfo {
    SurfaceInfo {
        id: id.to_owned(),
        kind: kind.to_owned(),
        title: title.clone(),
        item_count: None,
        unclassified: Vec::new(),
    }
}

/// The surfaces of one listed window: a `window` entry always, a `sheet`
/// entry alongside it when the window is a modal dialog.
pub(crate) fn surfaces_of(windows: &[ListedWindow]) -> Vec<SurfaceInfo> {
    windows
        .iter()
        .flat_map(|window| {
            let title = (!window.info.title.is_empty()).then(|| window.info.title.clone());
            std::iter::once("window")
                .chain(window.sheet.then_some("sheet"))
                .map(move |kind| surface(&window.info.id, kind, &title))
        })
        .collect()
}

/// The `sheet` entries of the dialogs drawn inside the windows, each on the
/// dialog's own id.
pub(crate) fn nested_entries(scan: &NestedScan) -> Vec<SurfaceInfo> {
    scan.found
        .iter()
        .map(|nested| surface(&nested.id, "sheet", &nested.title))
        .collect()
}

/// Names the `sheet` kind unclassified on the window entry of every window
/// whose tree was not read to the end, so a missing nested dialog is not
/// taken for an observed absence.
pub(crate) fn mark_unread(
    surfaces: &mut [SurfaceInfo],
    windows: &[ListedWindow],
    scan: &NestedScan,
) {
    for window in scan.unread.iter().filter_map(|&index| windows.get(index)) {
        for entry in surfaces
            .iter_mut()
            .filter(|entry| entry.kind == "window" && entry.id == window.info.id)
        {
            entry.unclassified.push("sheet".to_owned());
        }
    }
}

fn windows_of_process(
    bus: &SharedBus,
    pid: u32,
    deadline: Deadline,
) -> Result<Vec<ListedWindow>, AdapterError> {
    let registry = read_registry_for(bus, Some(pid), deadline)?;
    scoped_windows_of(bus, &registry, |app| app.root.pid() == pid, deadline)
}

/// The titles of the dialogs drawn inside the windows of one process, which
/// no list of its top-level windows holds. A blank title is an empty string.
pub(crate) fn nested_dialog_titles(
    bus: &SharedBus,
    pid: u32,
    deadline: Deadline,
) -> Result<Vec<String>, AdapterError> {
    let windows = windows_of_process(bus, pid, deadline)?;
    let mut inventory = Inventory::structural(bus, deadline);
    let scan = scan_windows(&windows, |window| inventory.read(window));
    Ok(scan
        .found
        .into_iter()
        .map(|nested| nested.title.unwrap_or_default())
        .collect())
}

/// Lists the surfaces the named process presents. The process identity is
/// checked first so a surface list never answers for a pid that has since
/// become a different process.
pub(crate) fn list_surfaces(
    bus: &SharedBus,
    process: &ProcessIdentity,
    deadline: Deadline,
) -> Result<Vec<SurfaceInfo>, AdapterError> {
    require_same_process(process)?;
    let windows = windows_of_process(bus, process.pid.get(), deadline)?;
    let mut inventory = Inventory::structural(bus, deadline);
    let scan = scan_windows(&windows, |window| inventory.read(window));
    let mut surfaces = surfaces_of(&windows);
    mark_unread(&mut surfaces, &windows, &scan);
    surfaces.extend(nested_entries(&scan));
    let owners: Vec<&WindowInfo> = windows.iter().map(|window| &window.info).collect();
    Ok(with_menu_leg(
        surfaces,
        menu_surface::surfaces_of(&mut inventory, &owners),
    ))
}

/// A menu scan that failed leaves the window and sheet entries standing and
/// marks the menu kind unread on every window, so a missing `menu` entry is
/// not mistaken for an observed absence.
pub(in crate::system) fn with_menu_leg(
    mut surfaces: Vec<SurfaceInfo>,
    menu: Result<Vec<SurfaceInfo>, AdapterError>,
) -> Vec<SurfaceInfo> {
    match menu {
        Ok(entries) => surfaces.extend(entries),
        Err(_) => {
            for entry in surfaces.iter_mut().filter(|entry| entry.kind == "window") {
                entry.unclassified.push("menu".to_owned());
            }
        }
    }
    surfaces
}

#[cfg(test)]
#[path = "surfaces_tests.rs"]
mod tests;
