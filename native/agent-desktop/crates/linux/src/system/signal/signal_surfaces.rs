use agent_desktop_core::{SnapshotSurface, SurfaceSignal};

use crate::system::menu::surface_scan::NestedScan;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::registry::registry_app::RegistryApp;

fn surface_signal(
    app: &RegistryApp,
    kind: SnapshotSurface,
    id: String,
    title: Option<String>,
) -> SurfaceSignal {
    SurfaceSignal {
        kind,
        app: app.name.clone(),
        pid: app.root.pid().into(),
        process_instance: app.facts.instance.clone(),
        id,
        title,
    }
}

/// One `Sheet` signal for every listed window the shared sheet predicate
/// accepts. The window stays in the window list too, so a dialog is one
/// `window-opened` and one `surface-appeared`, keyed on its id and never on
/// its name.
pub(crate) fn sheet_signals(
    windows: &[ListedWindow],
    registry_apps: &[RegistryApp],
) -> Vec<SurfaceSignal> {
    windows
        .iter()
        .filter(|window| window.sheet)
        .filter_map(|window| {
            let app = registry_apps.get(window.app)?;
            Some(surface_signal(
                app,
                SnapshotSurface::Sheet,
                window.info.id.clone(),
                Some(window.info.title.clone()).filter(|title| !title.is_empty()),
            ))
        })
        .collect()
}

/// Maps dialogs and menus found inside windows to their owning process.
/// Sheets precede menus so callers preserve the established signal ordering.
pub(crate) fn nested_surface_signals(
    scan: &NestedScan,
    windows: &[ListedWindow],
    registry_apps: &[RegistryApp],
) -> Vec<SurfaceSignal> {
    [
        (SnapshotSurface::Sheet, scan.found.as_slice()),
        (SnapshotSurface::Menu, scan.menus.as_slice()),
    ]
    .into_iter()
    .flat_map(|(kind, entries)| {
        entries.iter().filter_map(move |nested| {
            let app = registry_apps.get(windows.get(nested.window)?.app)?;
            Some(surface_signal(
                app,
                kind,
                nested.id.clone(),
                nested.title.clone(),
            ))
        })
    })
    .collect()
}

#[cfg(test)]
#[path = "signal_surfaces_tests.rs"]
mod tests;
