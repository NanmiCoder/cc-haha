use agent_desktop_core::{AdapterError, Deadline, ErrorCode, WindowInfo};

use super::window_enum::enumerate_top_level;
use super::window_identity::{WindowIdentityEvidence, live_window_title};
use super::window_ops::{is_foreground_window, parse_handle, passes_filter, window_state};

/// Resolves a live window by `WindowInfo.id`, corroborating pid and process
/// generation against the handle's current owner (stored-evidence rule).
pub(crate) fn resolve_window_strict(
    expected: &WindowInfo,
    deadline: Deadline,
) -> Result<WindowInfo, AdapterError> {
    deadline.ensure_remaining()?;
    let handle = parse_handle(&expected.id);
    if handle.is_null() {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "window id is not a Windows HWND-shaped id",
        ));
    }
    if !window_exists(handle) {
        return Err(AdapterError::new(
            ErrorCode::WindowNotFound,
            "window handle is no longer a live top-level window",
        ));
    }
    let Some(evidence) = WindowIdentityEvidence::from_info(handle, expected) else {
        return Err(AdapterError::new(
            ErrorCode::StaleRef,
            "headed focus requires a process-instance token on the stored window",
        ));
    };
    evidence.verify_stored()?;
    live_window_info(handle, expected)
}

fn live_window_info(
    handle: super::window_enum::WindowHandle,
    expected: &WindowInfo,
) -> Result<WindowInfo, AdapterError> {
    let mut found = None;
    enumerate_top_level(|window| {
        if window.handle != handle {
            return true;
        }
        found = Some(window);
        false
    })?;
    let window = found.ok_or_else(|| {
        AdapterError::new(
            ErrorCode::WindowNotFound,
            "window handle is no longer present in the top-level inventory",
        )
    })?;
    if !passes_filter(&window) && !window.iconic {
        return Err(AdapterError::new(
            ErrorCode::WindowNotFound,
            "window is no longer an agent-visible top-level window",
        ));
    }
    let focused = is_foreground_window(handle);
    Ok(WindowInfo {
        id: expected.id.clone(),
        title: live_window_title(handle).unwrap_or_else(|| expected.title.clone()),
        app: expected.app.clone(),
        pid: expected.pid,
        process_instance: expected.process_instance.clone(),
        bounds: Some(window.rect),
        state: window_state(focused, window.iconic, window.visible),
    })
}

#[cfg(target_os = "windows")]
fn window_exists(handle: super::window_enum::WindowHandle) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
    unsafe { IsWindow(handle) != 0 }
}

#[cfg(not(target_os = "windows"))]
fn window_exists(_handle: super::window_enum::WindowHandle) -> bool {
    false
}

#[cfg(test)]
#[path = "window_resolve_tests.rs"]
mod tests;
