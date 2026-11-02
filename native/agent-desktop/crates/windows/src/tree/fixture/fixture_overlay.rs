//! Same-root overlay staging for hit-test corroboration fixtures.
//!
//! The overlay HWND is created on the fixture pump thread during window setup.
//! Staging posts to that pump so visibility/z-order changes run on the owning
//! thread (cross-thread `CreateWindowExW` against an owned parent hangs).

use std::ffi::c_void;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, FindWindowExW, HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, PostMessageW,
    SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetWindowPos,
    ShowWindow, WS_CHILD,
};

use super::fixture_window;

const WM_STAGE_OVERLAY: u32 = 0x0400 + 2;
const CONTROL_BORDER: u32 = 0x0080_0000;
const OVERLAY_TEXT: &str = "fixture-overlay";

/// Private message the fixture WndProc handles by showing the overlay child.
pub(crate) const STAGE_OVERLAY_MESSAGE: u32 = WM_STAGE_OVERLAY;

/// Creates the hidden overlay sibling over the primary button.
pub(crate) fn create_hidden_overlay(parent: HWND) -> HWND {
    let class = fixture_window::wide("BUTTON");
    let text = fixture_window::wide(OVERLAY_TEXT);
    unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            text.as_ptr(),
            WS_CHILD | CONTROL_BORDER,
            8,
            8,
            200,
            24,
            parent,
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    }
}

/// Shows the pre-created overlay; invoked on the fixture pump thread.
pub(crate) fn show_overlay_child(parent: HWND) {
    let overlay = find_overlay(parent as isize);
    if overlay.is_null() {
        return;
    }
    unsafe {
        ShowWindow(overlay, SW_SHOWNOACTIVATE);
        SetWindowPos(
            overlay,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
    }
}

/// Asks the fixture pump to show the pre-created overlay sibling.
pub(crate) fn stage_sibling_overlay(parent: isize) -> *mut c_void {
    unsafe { PostMessageW(parent as *mut c_void, WM_STAGE_OVERLAY, 0, 0) };
    std::thread::sleep(std::time::Duration::from_millis(50));
    find_overlay(parent)
}

pub(crate) fn find_overlay(parent: isize) -> *mut c_void {
    let class = fixture_window::wide("BUTTON");
    let text = fixture_window::wide(OVERLAY_TEXT);
    unsafe {
        FindWindowExW(
            parent as *mut c_void,
            std::ptr::null_mut(),
            class.as_ptr(),
            text.as_ptr(),
        )
    }
}

pub(crate) fn raise_window(handle: isize) {
    unsafe {
        SetWindowPos(
            handle as *mut c_void,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
    }
}

pub(crate) fn clear_topmost(handle: isize) {
    unsafe {
        SetWindowPos(
            handle as *mut c_void,
            HWND_NOTOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}
