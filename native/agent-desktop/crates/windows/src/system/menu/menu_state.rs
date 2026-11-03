use agent_desktop_core::{AdapterError, Deadline, ErrorCode, ProcessId};

use crate::system::window::window_enum::{enumerate_top_level, window_is_responsive};

#[cfg(target_os = "windows")]
use crate::system::window::listing_retry::narrow_to_permitted_codes;

#[cfg(all(test, target_os = "windows"))]
use crate::system::runtime::thread_walk::{thread_snapshot_calls, thread_snapshot_closes};

/// Whether a menu is open right now for `pid`, composed from three sources
/// measured as covering the stacks the corpus could stage: the classic
/// `GetGUIThreadInfo` menu-mode flags read per thread of the target pid
/// (A23-1), a tool window of the pid with a Menu/MenuBar/MenuItem element
/// reachable at or under it (A23-11), and - measured on a real Chromium host
/// (A26-12) whose context menu is a DOM menu inside the app's own window,
/// invisible to both of the other sources - a visible non-tool window of the
/// pid with a Chromium-framework menu-family element reachable under it.
/// Bare Menu-family reachability alone is constant-true at idle on both
/// stacks (A23-1, A23-2) and is never used by itself - every source here is a
/// compound predicate that round-trips false across a real open and close,
/// and the framework gate keeps a Win32 menu bar from firing the Chromium arm
/// at rest.
pub(crate) fn menu_is_open(pid: ProcessId, deadline: Deadline) -> Result<bool, AdapterError> {
    deadline.ensure_remaining()?;
    ensure_process_exists(pid)?;
    deadline.ensure_remaining()?;
    if classic_menu_mode_active(pid, deadline)? {
        return Ok(true);
    }
    deadline.ensure_remaining()?;
    if uia_menu_reachable(pid, deadline)? {
        return Ok(true);
    }
    deadline.ensure_remaining()?;
    chromium_dom_menu_reachable(pid, deadline)
}

#[path = "menu_state_multi.rs"]
mod multi;
pub(crate) use multi::menus_open_for;

#[path = "menu_state_locate.rs"]
mod locate;
pub(crate) use locate::{MenuLocation, locate_menu};

#[path = "menu_state_chromium.rs"]
mod chromium;

#[cfg(target_os = "windows")]
fn process_not_found_error(pid: ProcessId) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "The target process could not be found",
    )
    .with_details(serde_json::json!({
        "kind": "process_not_found",
        "pid": u32::from(pid),
    }))
}

#[cfg(target_os = "windows")]
fn unresponsive_menu_probe_error() -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "A candidate menu window is not processing messages, so a UI Automation read would block",
    )
    .with_details(serde_json::json!({ "kind": "menu_probe_window_not_pumping" }))
}

/// A pid that does not exist must not read as a false "no menu open" -
/// neither source below fails on a nonexistent pid (an empty thread set and
/// an empty candidate list are both indistinguishable from "closed"), so
/// existence is checked explicitly. `ERROR_ACCESS_DENIED` means the process
/// is alive but its handle could not be opened; neither source needs that
/// handle, so this proceeds rather than misreporting a protected-but-live
/// target as gone.
#[cfg(target_os = "windows")]
fn ensure_process_exists(pid: ProcessId) -> Result<(), AdapterError> {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, u32::from(pid)) };
    if !handle.is_null() {
        unsafe { CloseHandle(handle) };
        return Ok(());
    }
    if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
        return Err(process_not_found_error(pid));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn ensure_process_exists(_pid: ProcessId) -> Result<(), AdapterError> {
    Ok(())
}

/// Source A (A23-1): a `TH32CS_SNAPTHREAD` snapshot filtered to `pid`, with
/// `GetGUIThreadInfo` called per thread. The existing call site in
/// `key_dispatch.rs` passes `0`, which asks about the foreground thread; this
/// predicate is asked about a named pid that may not be foreground, so every
/// one of that pid's threads is read individually instead.
#[cfg(target_os = "windows")]
fn classic_menu_mode_active(pid: ProcessId, deadline: Deadline) -> Result<bool, AdapterError> {
    let target = u32::from(pid);
    let found = crate::system::runtime::thread_walk::walk_gui_threads(deadline, |entry| {
        if entry.th32OwnerProcessID == target && thread_reports_menu_mode(entry.th32ThreadID) {
            Some(())
        } else {
            None
        }
    })?;
    Ok(found.is_some())
}

#[cfg(not(target_os = "windows"))]
fn classic_menu_mode_active(_pid: ProcessId, deadline: Deadline) -> Result<bool, AdapterError> {
    deadline.ensure_remaining()?;
    Ok(false)
}

/// A thread that exited between the snapshot and this read is skipped, not
/// an error: `GetGUIThreadInfo` returning failure is the same honest
/// absence-of-menu-mode signal for a gone thread and for a thread with no
/// GUI state at all (A23-10 measured a bare console process failing every
/// thread's read outright, never a zeroed success).
#[cfg(target_os = "windows")]
fn thread_reports_menu_mode(thread_id: u32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GUI_INMENUMODE, GUI_POPUPMENUMODE, GUI_SYSTEMMENUMODE, GUITHREADINFO, GetGUIThreadInfo,
    };

    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetGUIThreadInfo(thread_id, &mut info) } == 0 {
        return false;
    }
    info.flags & (GUI_INMENUMODE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE) != 0
}

/// Source B (A23-11): every root-level top-level window owned by `pid` that
/// carries `WS_EX_TOOLWINDOW` (the shipped agent-facing filter already
/// excludes these, so this predicate cannot fabricate a `window-opened`
/// event) is probed for a reachable `Menu`/`MenuBar`/`MenuItem` descendant.
/// This is the compound predicate A23-11 measured round-tripping
/// false-to-true-to-false on both classic Win32 and WPF context menus; a WPF
/// menu bar dropdown is also covered, a classic menu-bar dropdown is not
/// (A23-1 covers that stack fully on its own). A Chromium DOM menu surfaces
/// under no tool window at all - it lives inside the application's own
/// non-tool window - and is the third source's pool ([`chromium`]).
#[cfg(target_os = "windows")]
fn uia_menu_reachable(pid: ProcessId, deadline: Deadline) -> Result<bool, AdapterError> {
    deadline.ensure_remaining()?;
    let candidates = tool_window_candidates(pid)?;
    if candidates.is_empty() {
        return Ok(false);
    }
    let client = crate::tree::automation::automation_client().map_err(narrow_to_permitted_codes)?;
    let condition = menu_family_condition(&client)?;
    for (index, handle) in candidates.into_iter().enumerate() {
        if index > 0 {
            deadline.ensure_remaining()?;
        }
        if probe_candidate(&client, &condition, handle)? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(not(target_os = "windows"))]
fn uia_menu_reachable(_pid: ProcessId, deadline: Deadline) -> Result<bool, AdapterError> {
    deadline.ensure_remaining()?;
    Ok(false)
}

/// Source C (A26-12): the Chromium/Electron DOM-menu arm, module
/// [`self::chromium`]. Neither of the other two sources can see a Chromium
/// context menu - it is a DOM menu inside the application's own non-tool
/// window, so no classic flag fires and no tool window carries it.
use chromium::chromium_dom_menu_reachable;

#[cfg(target_os = "windows")]
fn tool_window_candidates(pid: ProcessId) -> Result<Vec<isize>, AdapterError> {
    let mut handles = Vec::new();
    enumerate_top_level(|window| {
        if crate::system::window::window_identity::live_window_owner(window.handle) == Some(pid)
            && window.tool
        {
            handles.push(window.handle as isize);
        }
        true
    })
    .map_err(narrow_to_permitted_codes)?;
    Ok(handles)
}

/// One `ControlType` narrowed to a UIA property condition, the building
/// block every menu-family search ORs together - shared with
/// `chromium::menu_family_condition_without_bar`.
#[cfg(target_os = "windows")]
fn control_type_condition(
    client: &uiautomation::UIAutomation,
    control: uiautomation::types::ControlType,
) -> Result<uiautomation::core::UICondition, AdapterError> {
    use uiautomation::types::UIProperty;
    use uiautomation::variants::Variant;

    client
        .create_property_condition(UIProperty::ControlType, Variant::from(control as i32), None)
        .map_err(|error| {
            narrow_to_permitted_codes(crate::tree::automation::uia_error(
                &error,
                "build the menu-family search condition",
            ))
        })
}

#[cfg(target_os = "windows")]
fn menu_family_condition(
    client: &uiautomation::UIAutomation,
) -> Result<uiautomation::core::UICondition, AdapterError> {
    use uiautomation::types::ControlType;

    let menu = control_type_condition(client, ControlType::Menu)?;
    let menu_bar = control_type_condition(client, ControlType::MenuBar)?;
    let menu_item = control_type_condition(client, ControlType::MenuItem)?;
    let menu_or_bar = client
        .create_or_condition(menu, menu_bar)
        .map_err(|error| {
            narrow_to_permitted_codes(crate::tree::automation::uia_error(
                &error,
                "combine the menu-family search condition",
            ))
        })?;
    client
        .create_or_condition(menu_or_bar, menu_item)
        .map_err(|error| {
            narrow_to_permitted_codes(crate::tree::automation::uia_error(
                &error,
                "combine the menu-family search condition",
            ))
        })
}

/// Gated on [`window_is_responsive`] before any cross-process UI Automation
/// call: a target that stopped dispatching would otherwise block a read this
/// predicate's callers cannot rescue - `wait_for_menu` makes one call with no
/// retry of its own, so an in-flight block has no backstop at any layer.
#[cfg(target_os = "windows")]
pub(in crate::system) fn probe_candidate(
    client: &uiautomation::UIAutomation,
    condition: &uiautomation::core::UICondition,
    handle: isize,
) -> Result<bool, AdapterError> {
    probe_candidate_element(client, condition, handle).map(|found| found.is_some())
}

/// [`probe_candidate`] with the found element kept instead of dropped. The
/// probe already located the menu-family element on its positive answer; the
/// `Menu` surface arm needs exactly that element to root the observation at,
/// so the discard was the only difference between the two callers.
#[cfg(target_os = "windows")]
pub(in crate::system) fn probe_candidate_element(
    client: &uiautomation::UIAutomation,
    condition: &uiautomation::core::UICondition,
    handle: isize,
) -> Result<Option<uiautomation::UIElement>, AdapterError> {
    use uiautomation::types::{Handle, TreeScope};

    if !crate::tree::automation::window_exists(handle) {
        return Ok(None);
    }
    if !window_is_responsive(handle as *mut core::ffi::c_void) {
        return Err(unresponsive_menu_probe_error());
    }
    let element = match client.element_from_handle(Handle::from(handle)) {
        Ok(element) => element,
        Err(error) => {
            return probe_step(&error, "resolve a candidate menu window").map(|_| None);
        }
    };
    match element.find_first(TreeScope::Subtree, condition) {
        Ok(found) => Ok(Some(found)),
        Err(error) => probe_step(
            &error,
            "search a candidate window for a reachable menu element",
        )
        .map(|_| None),
    }
}

/// A vanished candidate - the window closed between discovery and this read,
/// the ordinary close race at a 50ms poll interval - is skipped rather than
/// reported, mirroring source A's own exited-thread skip. `is_exhaustion`
/// covers `find_first` finding nothing; the element-not-available family
/// covers the window itself having gone away mid-read.
#[cfg(target_os = "windows")]
fn probe_step(error: &uiautomation::Error, context: &str) -> Result<bool, AdapterError> {
    let failure = crate::tree::automation::failure_of(error);
    if failure.is_absence() {
        return Ok(false);
    }
    Err(narrow_to_permitted_codes(
        crate::tree::automation::uia_failure_error(failure, context),
    ))
}

#[cfg(test)]
#[path = "menu_state_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "menu_state_chromium_tests.rs"]
mod chromium_tests;
