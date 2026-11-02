use agent_desktop_core::ProcessId;

#[cfg(target_os = "windows")]
use super::window_enum::WindowHandle;

/// The top-level window class the shell gives a hosted application's frame
/// (A26-8: the foreground window while a hosted Settings session is active).
#[cfg(target_os = "windows")]
const FRAME_WINDOW_CLASS: &str = "ApplicationFrameWindow";

/// The window class a hosted application's own surface presents inside its
/// host's frame (A26-8: the frame's immediate children split by pid - the
/// title bar and input sink on the frame host's pid, the CoreWindow on the
/// hosted application's).
#[cfg(target_os = "windows")]
const CORE_WINDOW_CLASS: &str = "Windows.UI.Core.CoreWindow";

/// The process a top-level window hosts, when that window is an application
/// frame host frame carrying a live hosted application (A26-8).
///
/// Detection requires both the `ApplicationFrameWindow` class and a child
/// `Windows.UI.Core.CoreWindow` whose owning process differs from the
/// frame's. The class alone is insufficient: this desktop carries
/// `ApplicationFrameWindow` frames owned by the shell with no hosted
/// `CoreWindow` beneath them, and treating those as hosted would attribute
/// a phantom application to the desktop. Suspension drops the hosted
/// `CoreWindow` while its frame survives uncloaked (measured on this
/// build by activating the same single-instanced frame twice), so a
/// suspended application's frame reads as its frame host until the
/// application resumes - and every identity that was verified against the
/// hosted pid fails closed for exactly as long.
///
/// `None` is every kind of "no hosted application here": a different
/// class, an unreadable owner, no `CoreWindow` child, and every
/// `CoreWindow` child owned by the frame's own process.
#[cfg(target_os = "windows")]
pub(crate) fn hosted_application_pid(handle: WindowHandle) -> Option<ProcessId> {
    if super::window_ops::window_class_name(handle)?.as_str() != FRAME_WINDOW_CLASS {
        return None;
    }
    let frame_pid = super::window_identity::live_window_owner(handle)?;
    let core_window = foreign_owned_core_window_child(handle, frame_pid)?;
    super::window_identity::live_window_owner(core_window)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn hosted_application_pid(
    _handle: super::window_enum::WindowHandle,
) -> Option<ProcessId> {
    None
}

/// The first child `CoreWindow` whose owning process differs from the
/// frame's, walked in z-order through the frame's immediate children. A
/// child whose owner cannot be read is passed over, not fatal: one raced
/// child must not fail the walk while a later sibling could still answer.
#[cfg(target_os = "windows")]
fn foreign_owned_core_window_child(
    frame: WindowHandle,
    frame_pid: ProcessId,
) -> Option<WindowHandle> {
    use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowExW;

    let class = wide(CORE_WINDOW_CLASS);
    let mut after = std::ptr::null_mut();
    loop {
        let child = unsafe { FindWindowExW(frame, after, class.as_ptr(), std::ptr::null()) };
        if child.is_null() {
            return None;
        }
        match super::window_identity::live_window_owner(child) {
            Some(pid) if pid != frame_pid => return Some(child),
            _ => after = child,
        }
    }
}

#[cfg(target_os = "windows")]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
#[path = "frame_identity_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "frame_identity_settings_tests.rs"]
mod settings_tests;
