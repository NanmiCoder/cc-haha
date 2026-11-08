use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ProcessId, WindowFilter, WindowInfo, WindowState,
    app_name_matches,
};

#[cfg(target_os = "windows")]
use super::frame_identity;
use super::listing_retry::retry_transient_window_race;
use super::window_enum::{EnumeratedWindow, enumerate_top_level};
use super::window_identity::WindowIdentityEvidence;
use crate::system::process_identity;

/// The filter the A16-1 census justifies: a window an agent means is
/// visible, has a non-zero rect, is not cloaked by the shell, and is not a
/// tool window. Each criterion cites its census row (A16-1 measured 147
/// top-level windows of which 137 invisible, 93 zero-size, 6 cloaked and
/// 51 tool).
pub(crate) fn passes_filter(window: &EnumeratedWindow) -> bool {
    window.visible && !window.is_zero_sized() && !window.cloaked && !window.tool
}

/// The process facts one window needs: its owner's pid, the process-generation
/// token and the image name that becomes `app` - all read from the same
/// handle.
#[cfg(target_os = "windows")]
fn process_facts(
    handle: super::window_enum::WindowHandle,
) -> Option<(ProcessId, Option<String>, String)> {
    let pid = super::window_identity::live_window_owner(handle)?;
    let token = process_identity::token_for_pid(pid).ok().flatten();
    let name = process_identity::process_image_name(pid).unwrap_or_default();
    Some((pid, token, name))
}

#[cfg(not(target_os = "windows"))]
fn process_facts(
    _handle: super::window_enum::WindowHandle,
) -> Option<(ProcessId, Option<String>, String)> {
    None
}

/// Reads the window class of a handle, or `None` when the handle addresses
/// nothing or the read fails - the same unanswerable contract
/// `live_window_owner` draws for the process read beside which this sits.
#[cfg(target_os = "windows")]
pub(crate) fn window_class_name(handle: super::window_enum::WindowHandle) -> Option<String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;

    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(handle, buffer.as_mut_ptr(), buffer.len() as i32) };
    if length <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..length as usize]))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn window_class_name(_handle: super::window_enum::WindowHandle) -> Option<String> {
    None
}

/// The identity facts one listed window reports: its own process's, or -
/// when the window is an application frame host frame carrying a live
/// hosted application (A26-8) - the hosted application's, read lazily per
/// hosted frame the way `live_window_title` reads a title. The frame keeps
/// the id, title, bounds and state; only `app` and `pid` descend to
/// the hosted process, and the descent runs inside this one inventory pass
/// rather than as a second enumeration.
#[cfg(target_os = "windows")]
fn identity_facts(
    handle: super::window_enum::WindowHandle,
) -> Option<(ProcessId, Option<String>, String)> {
    if let Some(pid) = frame_identity::hosted_application_pid(handle) {
        let token = process_identity::token_for_pid(pid).ok().flatten();
        let name = process_identity::process_image_name(pid).unwrap_or_default();
        return Some((pid, token, name));
    }
    process_facts(handle)
}

#[cfg(not(target_os = "windows"))]
fn identity_facts(
    handle: super::window_enum::WindowHandle,
) -> Option<(ProcessId, Option<String>, String)> {
    process_facts(handle)
}

/// Builds one `WindowInfo` from an enumerated window: the frame's handle,
/// geometry and title carrying the identity facts already resolved for it.
fn window_info_from(
    window: EnumeratedWindow,
    title: &str,
    facts: (ProcessId, Option<String>, String),
    focused: bool,
) -> WindowInfo {
    let (pid, process_instance, app) = facts;
    WindowInfo {
        id: window_id(window.handle),
        title: title.to_string(),
        app,
        pid,
        process_instance,
        bounds: Some(window.rect),
        state: window_state(focused, window.iconic, window.visible),
    }
}

/// The live top-level window inventory an agent means, per the A16-1 filter.
///
/// Bounds every native call under `deadline` and absorbs the transient
/// mid-walk identity race internally, up to the shared listing-retry budget:
/// a caller polling this entry point - `wait --window` chief among them -
/// cannot retry a refusal itself, since `WindowNotFound` is not in its
/// retryable set. A race that survives the whole budget still returns the
/// same `WindowNotFound` refusal this inventory has always reported, so the
/// shipped refusal semantics are unchanged in kind.
pub(crate) fn list_windows_live(
    filter: &WindowFilter,
    deadline: Deadline,
) -> Result<Vec<WindowInfo>, AdapterError> {
    retry_transient_window_race(deadline, is_window_identity_race, || {
        list_windows_live_once(filter, deadline)
    })
}

fn is_window_identity_race(error: &AdapterError) -> bool {
    error.code == ErrorCode::WindowNotFound
}

/// One single-shot walk of the live top-level window inventory.
///
/// Verification re-runs on both sides of the read (the two-sided rule macOS's
/// `windows_from_records_with_focus` in `window_inventory.rs` carries): the owning process is re-checked
/// after assembly, and a window whose process changed mid-listing fails the
/// whole walk rather than emitting a half-identified entry - the race
/// `list_windows_live` retries this whole function for.
fn list_windows_live_once(
    filter: &WindowFilter,
    deadline: Deadline,
) -> Result<Vec<WindowInfo>, AdapterError> {
    #[cfg(test)]
    enumeration_calls::record();

    let mut windows = Vec::new();
    let mut focused_seen = false;
    let app_filter = filter.app.as_deref();
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
        if !passes_filter(&window) {
            return true;
        }
        let Some((pid, token, app)) = identity_facts(window.handle) else {
            return true;
        };
        if let Some(filter_name) = app_filter {
            if !app_name_matches(&app, filter_name) {
                return true;
            }
        }
        let title = super::window_identity::live_window_title(window.handle).unwrap_or_default();
        let focused = !focused_seen && is_foreground_window(window.handle);
        if filter.focused_only && !focused {
            return true;
        }
        focused_seen |= focused;
        let info = window_info_from(window, &title, (pid, token, app), focused);
        if let Err(error) = re_verify(&info) {
            *failure.borrow_mut() = Some(error);
            return false;
        }
        windows.push(info);
        true
    })?;

    if let Some(error) = failure.into_inner() {
        return Err(error);
    }

    #[cfg(all(test, target_os = "windows"))]
    if force_window_not_found::consume_if_armed() {
        return Err(forced_race_signal());
    }

    Ok(windows)
}

#[cfg(all(test, target_os = "windows"))]
fn forced_race_signal() -> AdapterError {
    AdapterError::new(ErrorCode::WindowNotFound, "forced test identity race")
}

/// Whether a handle is the desktop's foreground window right now.
pub(crate) fn is_foreground_window(handle: super::window_enum::WindowHandle) -> bool {
    #[cfg(all(test, target_os = "windows"))]
    if let Some(forced) = forced_foreground::current() {
        return forced == handle as isize;
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        unsafe { GetForegroundWindow() == handle }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = handle;
        false
    }
}

/// Whether the handle or its root ancestor owns the desktop foreground.
/// Child control HWNDs from WinForms/WPF are rarely foreground themselves
/// even when their top-level window is.
pub(crate) fn is_root_foreground_window(handle: super::window_enum::WindowHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow};
        const GA_ROOT: u32 = 2;
        if handle.is_null() {
            return false;
        }
        unsafe {
            let foreground = GetForegroundWindow();
            if foreground.is_null() {
                return false;
            }
            if foreground == handle {
                return true;
            }
            let root = GetAncestor(handle, GA_ROOT);
            !root.is_null() && root == foreground
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = handle;
        false
    }
}

/// Re-verifies a freshly listed window's identity per the two-sided rule, and
/// both checks bind: the strict one covers app and title, which the stored
/// path deliberately does not, while the stored one covers live handle
/// ownership, which the strict path cannot see because its pid was derived
/// from that same handle a moment earlier. A window destroyed or re-owned
/// between assembly and verification fails the inventory rather than
/// emitting a half-identified entry, so both failures return.
fn re_verify(info: &WindowInfo) -> Result<(), AdapterError> {
    let handle = parse_handle(&info.id);
    let Some(evidence) = WindowIdentityEvidence::from_info(handle, info) else {
        return Ok(());
    };
    evidence.verify_strict()?;
    evidence.verify_stored()
}

pub(crate) fn parse_handle(id: &str) -> super::window_enum::WindowHandle {
    id.strip_prefix("w-")
        .and_then(|number| number.parse::<usize>().ok())
        .map(|value| value as super::window_enum::WindowHandle)
        .unwrap_or(std::ptr::null_mut())
}

/// The signed handle a `w-<n>` window id names, or `InvalidArgs` when the id
/// is not that shape or names the null handle. The strict counterpart of
/// [`parse_handle`], which maps every malformed id to the null handle.
pub(crate) fn parse_window_id(id: &str) -> Result<isize, AdapterError> {
    id.strip_prefix("w-")
        .and_then(|number| number.parse::<isize>().ok())
        .filter(|handle| *handle > 0)
        .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "Malformed window identifier"))
}

/// The inverse of [`parse_handle`]: the `WindowInfo.id` a live handle
/// reports. Always through `usize` - never the handle's own signed width -
/// so every id this crate emits is one `parse_handle` can round-trip.
pub(crate) fn window_id(handle: super::window_enum::WindowHandle) -> String {
    format!("w-{}", handle as usize)
}

/// The `WindowState` shape every live `WindowInfo` this crate builds shares:
/// `accessible` is always true for a window this process could observe at
/// all, and `minimized`/`visible` are always known once observed, never
/// absent.
pub(crate) fn window_state(is_focused: bool, minimized: bool, visible: bool) -> WindowState {
    WindowState {
        is_focused,
        accessible: true,
        minimized: Some(minimized),
        visible: Some(visible),
    }
}

#[cfg(test)]
pub(in crate::system) mod enumeration_calls {
    use std::cell::Cell;

    thread_local! {
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }

    pub(in crate::system) fn record() {
        crate::system::fixture::call_counter::record(&COUNT);
    }

    pub(in crate::system) fn take() -> usize {
        crate::system::fixture::call_counter::take(&COUNT)
    }
}

/// Pins which handle [`is_foreground_window`] reports as the foreground for
/// the closure's run on this thread, so a test can stage "this window owns the
/// foreground" without racing the live desktop for it.
#[cfg(all(test, target_os = "windows"))]
pub(in crate::system) mod forced_foreground {
    use std::cell::Cell;

    thread_local! {
        static FORCED: Cell<Option<isize>> = const { Cell::new(None) };
    }

    pub(in crate::system) fn current() -> Option<isize> {
        FORCED.with(Cell::get)
    }

    pub(in crate::system) fn with<R>(handle: isize, run: impl FnOnce() -> R) -> R {
        struct ResetOnDrop;
        impl Drop for ResetOnDrop {
            fn drop(&mut self) {
                FORCED.with(|cell| cell.set(None));
            }
        }
        FORCED.with(|cell| cell.set(Some(handle)));
        let _reset = ResetOnDrop;
        run()
    }
}

#[cfg(all(test, target_os = "windows"))]
pub(in crate::system) mod force_window_not_found {
    use std::cell::Cell;

    thread_local! {
        static REMAINING: Cell<usize> = const { Cell::new(0) };
    }

    pub(super) fn with<R>(times: usize, run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_usize_flag(&REMAINING, times, run)
    }

    pub(super) fn consume_if_armed() -> bool {
        REMAINING.with(|cell| {
            let remaining = cell.get();
            if remaining == 0 {
                false
            } else {
                cell.set(remaining - 1);
                true
            }
        })
    }
}

#[cfg(test)]
#[path = "window_ops_tests.rs"]
mod tests;
