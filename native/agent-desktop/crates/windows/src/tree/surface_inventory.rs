use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ProcessId, ProcessIdentity, SnapshotSurface, SurfaceInfo,
};

use super::automation::root_from_hwnd;
use super::properties::property_ids::TreeProperty;
use super::properties::property_outcome::PropertyOutcome;
use super::properties::read_one;
use crate::system::menu::menu_state::{MenuLocation, locate_menu};
use crate::system::window::window_enum::{EnumeratedWindow, WindowHandle, enumerate_top_level};
use crate::system::window::window_identity::{live_window_owner, live_window_title};
use crate::system::window::window_ops::{is_foreground_window, passes_filter};

/// The surfaces the named process presents right now.
///
/// Every agent-facing top-level window is a `window` surface, the foreground
/// one is also `focused`, a window whose `WindowIsModal` reads true is a
/// `sheet`, and a process with an open menu presents one `menu` surface. The
/// window-backed surfaces carry the same `w-<hwnd>` identity `list_windows`
/// emits, so a surface id is consumed by the window observation path without
/// a second lookup.
///
/// The classifications are the surface path's own - the window's
/// `WindowIsModal` property and the `menu_state` detector - so this inventory
/// and `snapshot --surface` can never disagree about what a window or a menu
/// is; a `WindowIsModal` read that failed is reported, not read as false. Shell surfaces are
/// not in a per-process inventory: they belong to the shell, not to any named
/// process, and folding them in would make every process appear to own the
/// taskbar. A process with no windows answers an empty list, which is a
/// successful answer about that process, not a refusal.
///
/// A menu probe that faults costs the process its `menu` classification and
/// nothing else, the same way an unreadable window costs only its `sheet`.
pub(crate) fn list_surfaces_for_process(
    process: ProcessIdentity,
    deadline: Deadline,
) -> Result<Vec<SurfaceInfo>, AdapterError> {
    deadline.ensure_remaining()?;
    require_live_process(&process)?;
    let windows = windows_of(process.pid, deadline)?;
    let observed: Vec<ObservedWindow> = windows
        .iter()
        .map(|window| ObservedWindow {
            handle: window.handle,
            title: live_window_title(window.handle),
            foreground: is_foreground_window(window.handle),
            sheet: is_modal_sheet(window.handle, deadline),
        })
        .collect();
    deadline.ensure_remaining()?;
    let located = locate_menu(process.pid, deadline);
    let (mut surfaces, menu) = inventory_with_menu(observed, process.pid, located)?;
    if let Some(menu) = menu {
        surfaces.push(menu_surface(&menu)?);
    }
    Ok(surfaces)
}

/// The caller's generation token must still be the process at `pid` right
/// now, the same fail-closed corroboration every other named-process entry
/// point on this adapter applies before answering.
fn require_live_process(process: &ProcessIdentity) -> Result<(), AdapterError> {
    if crate::system::process_identity::matches_instance(process.pid, &process.instance)? {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::AppNotFound,
        "The named process is not running, or the pid now runs a different generation",
    ))
}

/// The pid's agent-facing top-level windows, from the one enumeration pass
/// every window inventory on this platform shares - the same walk
/// `list_windows` and the menu detector draw from, filtered by the same
/// census predicate.
fn windows_of(pid: ProcessId, deadline: Deadline) -> Result<Vec<EnumeratedWindow>, AdapterError> {
    let mut windows = Vec::new();
    let failure = std::cell::RefCell::new(None);
    let mut seen = 0usize;
    enumerate_top_level(|window| {
        if seen > 0 {
            if let Err(error) = deadline.ensure_remaining() {
                *failure.borrow_mut() = Some(error);
                return false;
            }
        }
        seen += 1;
        if live_window_owner(window.handle) == Some(pid) && passes_filter(&window) {
            windows.push(window);
        }
        true
    })?;
    if let Some(error) = failure.into_inner() {
        return Err(error);
    }
    Ok(windows)
}

fn surface(kind: SnapshotSurface, handle: WindowHandle, title: Option<String>) -> SurfaceInfo {
    SurfaceInfo {
        id: format!("w-{}", handle as usize),
        kind: kind.as_str().to_string(),
        title,
        item_count: None,
        unclassified: Vec::new(),
    }
}

/// One window as this inventory observed it. The sheet probe is carried as a
/// `Result` rather than resolved here, so the rule about what a failed probe
/// costs is decided in one pure place and can be tested without a desktop.
pub(crate) struct ObservedWindow {
    pub(crate) handle: WindowHandle,
    pub(crate) title: Option<String>,
    pub(crate) foreground: bool,
    pub(crate) sheet: Result<bool, AdapterError>,
}

/// One window whose UIA root cannot be read costs that window its `sheet`
/// classification and nothing else. Its `window` entry names `sheet` as
/// unclassified, so the missing entry does not read as "no dialog open" -
/// and a modal dialog is the likeliest reason a window stops answering UIA.
/// Propagating the fault discarded every surface already collected for the
/// process, so a single hung window erased its responsive siblings from the
/// inventory - where the observation path reports the partial it did observe
/// rather than a discard.
pub(crate) fn surfaces_of(observed: Vec<ObservedWindow>) -> Vec<SurfaceInfo> {
    let mut surfaces = Vec::new();
    for window in observed {
        let mut entry = surface(SnapshotSurface::Window, window.handle, window.title.clone());
        if window.sheet.is_err() {
            entry
                .unclassified
                .push(SnapshotSurface::Sheet.as_str().to_string());
        }
        surfaces.push(entry);
        if window.foreground {
            surfaces.push(surface(
                SnapshotSurface::Focused,
                window.handle,
                window.title.clone(),
            ));
        }
        match window.sheet {
            Ok(true) => surfaces.push(surface(SnapshotSurface::Sheet, window.handle, window.title)),
            Ok(false) => {}
            Err(error) => trace_unreadable_window(window.handle, &error),
        }
    }
    surfaces
}

/// Folds the menu probe's own `Result` into the window surfaces already
/// collected, in one pure place that can be exercised in both directions
/// without a desktop.
///
/// A menu probe that faults says nothing about the windows, which were read
/// from the window census rather than from UIA - so it costs the process its
/// `menu` classification and nothing else, and each `window` entry names
/// `menu` as unclassified. Propagating it discarded every window surface
/// already collected, which is the same erasure a failed modal probe used to
/// cause.
///
/// A budget exhaustion and a process that has died are not that: neither is
/// evidence that no menu is open, and answering "no menu" for a probe that
/// never finished would relocate the very defect this fold exists to prevent.
/// Those two keep their own codes. Every UIA fault on this path is already
/// narrowed to `APP_UNRESPONSIVE` by the read-path narrowing the menu
/// detector applies, so the two propagating codes cannot swallow one.
pub(crate) fn inventory_with_menu<T>(
    observed: Vec<ObservedWindow>,
    pid: ProcessId,
    located: Result<Option<T>, AdapterError>,
) -> Result<(Vec<SurfaceInfo>, Option<T>), AdapterError> {
    let surfaces = surfaces_of(observed);
    match located {
        Ok(menu) => Ok((surfaces, menu)),
        Err(error) if refuses_the_listing(&error) => Err(error),
        Err(error) => {
            trace_unreadable_menu(pid, &error);
            Ok((mark_menu_unread(surfaces), None))
        }
    }
}

fn mark_menu_unread(mut surfaces: Vec<SurfaceInfo>) -> Vec<SurfaceInfo> {
    let window = SnapshotSurface::Window.as_str();
    for entry in surfaces.iter_mut().filter(|entry| entry.kind == window) {
        entry
            .unclassified
            .push(SnapshotSurface::Menu.as_str().to_string());
    }
    surfaces
}

fn refuses_the_listing(error: &AdapterError) -> bool {
    matches!(error.code, ErrorCode::Timeout | ErrorCode::AppNotFound)
}

fn trace_unreadable_menu(pid: ProcessId, error: &AdapterError) {
    tracing::debug!(
        code = %error.code.as_str(),
        pid = u32::from(pid),
        "a process's open-menu classification could not be read; its window surfaces stand"
    );
}

fn trace_unreadable_window(handle: WindowHandle, error: &AdapterError) {
    tracing::debug!(
        code = %error.code.as_str(),
        handle = handle as usize,
        "a window's modal classification could not be read; its other surfaces stand"
    );
}

/// The modal classification is the surface path's own predicate, read from
/// the window's UIA root exactly as `snapshot --surface sheet` reads it.
fn is_modal_sheet(handle: WindowHandle, deadline: Deadline) -> Result<bool, AdapterError> {
    let root = root_from_hwnd(handle as isize, deadline)?;
    modal_classification(read_one(&root, TreeProperty::WindowIsModal))
}

/// A provider that answered, or that does not implement `WindowIsModal`,
/// classifies the window; a read that failed is no answer, so the window's
/// `sheet` classification is reported as unclassified instead of absent.
pub(crate) fn modal_classification(outcome: PropertyOutcome) -> Result<bool, AdapterError> {
    match outcome {
        PropertyOutcome::Unknown => Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "the window's WindowIsModal property could not be read",
        )),
        outcome => Ok(matches!(outcome.flag(), Some(true))),
    }
}

fn menu_surface(menu: &MenuLocation) -> Result<SurfaceInfo, AdapterError> {
    let (title, item_count) = menu_decorations(menu);
    Ok(SurfaceInfo {
        id: format!("w-{}", menu.root_handle()),
        kind: SnapshotSurface::Menu.as_str().to_string(),
        title,
        item_count,
        unclassified: Vec::new(),
    })
}

/// Both decorations are reads on the element the detector already located and
/// proved reachable, so a read that races the menu closing omits its field
/// rather than failing the listing - `SurfaceInfo` skips `None`.
#[cfg(target_os = "windows")]
fn menu_decorations(menu: &MenuLocation) -> (Option<String>, Option<usize>) {
    let title = menu.element.get_name().ok().filter(|name| !name.is_empty());
    (title, menu_item_count(menu).ok())
}

#[cfg(not(target_os = "windows"))]
fn menu_decorations(_menu: &MenuLocation) -> (Option<String>, Option<usize>) {
    (None, None)
}

/// One scoped child read of the already-located element: the detector's walk
/// found this element, and counting its direct items is the follow-up that
/// populates `item_count` where the surface has countable children. No second
/// search of the desktop happens - the element is in hand.
#[cfg(target_os = "windows")]
fn menu_item_count(menu: &MenuLocation) -> Result<usize, AdapterError> {
    use uiautomation::types::TreeScope;

    let client = crate::tree::automation::automation_client()?;
    let condition = client.create_true_condition().map_err(|error| {
        crate::tree::automation::uia_error(&error, "build the menu item-count condition")
    })?;
    let items = menu
        .element
        .find_all(TreeScope::Children, &condition)
        .map_err(|error| {
            crate::tree::automation::uia_error(&error, "read the located menu's items")
        })?;
    Ok(items.len())
}

#[cfg(test)]
#[path = "surface_inventory_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "surface_inventory_partial_tests.rs"]
mod partial_tests;
