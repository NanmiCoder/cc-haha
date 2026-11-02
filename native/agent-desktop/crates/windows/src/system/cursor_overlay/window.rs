//! The click-through, never-focused surface the overlay paints onto.
//!
//! The extended style set is load-bearing and measured rather than assumed:
//! with `WS_EX_NOACTIVATE` the window took the foreground at none of create,
//! show, paint or move, and without it at three of those four.
//! `WS_EX_TRANSPARENT` is the click-through guarantee, and the same flag is
//! why hit-testing cannot be used to ask whether the overlay is on screen —
//! that question is answered by a pixel.
//!
//! `UpdateLayeredWindow` takes the whole surface at once, so no `WM_PAINT`
//! is needed; the message loop exists so the window keeps answering the
//! system rather than being marked hung, and is pumped without blocking so
//! the control loop keeps its own pace. `overlay_proc` handles nothing
//! itself — topology changes such as a DPI or display change are picked up
//! by re-probing on the idle tick, not by handling a message here.

#[cfg(target_os = "windows")]
use crate::system::cursor_overlay::dib::Dib;
#[cfg(target_os = "windows")]
use crate::system::cursor_overlay::wide::{wide, win32_error};
#[cfg(target_os = "windows")]
use agent_desktop_core::AdapterError;
#[cfg(target_os = "windows")]
use std::sync::Once;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{AC_SRC_ALPHA, AC_SRC_OVER, BLENDFUNCTION};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, HWND_TOPMOST, MSG, PM_REMOVE,
    PeekMessageW, RegisterClassExW, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SetWindowPos, ShowWindow, TranslateMessage, ULW_ALPHA, UpdateLayeredWindow,
    WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_POPUP,
};

#[cfg(target_os = "windows")]
const CLASS_NAME: &str = "AgentDesktopCursorOverlay";
#[cfg(target_os = "windows")]
static REGISTER: Once = Once::new();

#[cfg(target_os = "windows")]
unsafe extern "system" fn overlay_proc(
    window: HWND,
    message: u32,
    w: WPARAM,
    l: LPARAM,
) -> LRESULT {
    unsafe { DefWindowProcW(window, message, w, l) }
}

#[cfg(target_os = "windows")]
pub(crate) struct OverlayWindow {
    handle: HWND,
}

#[cfg(target_os = "windows")]
impl OverlayWindow {
    pub(crate) fn create() -> Result<Self, AdapterError> {
        REGISTER.call_once(|| {
            let class = wide(CLASS_NAME);
            let mut descriptor: WNDCLASSEXW = unsafe { std::mem::zeroed() };
            descriptor.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
            descriptor.lpfnWndProc = Some(overlay_proc);
            descriptor.hInstance = unsafe { GetModuleHandleW(std::ptr::null()) };
            descriptor.lpszClassName = class.as_ptr();
            unsafe { RegisterClassExW(&descriptor) };
        });

        let class = wide(CLASS_NAME);
        let title = wide("agent-desktop cursor overlay");
        let handle = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED
                    | WS_EX_TRANSPARENT
                    | WS_EX_TOOLWINDOW
                    | WS_EX_NOACTIVATE
                    | WS_EX_TOPMOST,
                class.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            )
        };
        if handle.is_null() {
            return Err(win32_error(
                "The cursor overlay window could not be created",
            ));
        }
        Ok(Self { handle })
    }

    /// Re-raises within the topmost band on every present, because the
    /// shell's own chrome is topmost too and the most recently raised
    /// window wins inside that band.
    pub(crate) fn raise(&self) {
        unsafe {
            SetWindowPos(
                self.handle,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            );
        }
    }

    /// Places and paints the surface in one call. Position, size and
    /// pixels move together, so the window never shows a frame's content
    /// at the previous frame's position.
    pub(crate) fn present(
        &self,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        pixels: &[u32],
    ) -> Result<(), AdapterError> {
        if width <= 0 || height <= 0 || pixels.len() < (width as usize) * (height as usize) {
            unsafe { ShowWindow(self.handle, SW_HIDE) };
            return Ok(());
        }
        let Some(mut dib) = Dib::create(width, height) else {
            return Err(win32_error(
                "The overlay's drawing surface could not be made",
            ));
        };
        dib.pixels()[..(width as usize) * (height as usize)]
            .copy_from_slice(&pixels[..(width as usize) * (height as usize)]);

        let position = windows_sys::Win32::Foundation::POINT { x, y };
        let source = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        let size = windows_sys::Win32::Foundation::SIZE {
            cx: width,
            cy: height,
        };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let updated = unsafe {
            UpdateLayeredWindow(
                self.handle,
                dib.screen_dc(),
                &position,
                &size,
                dib.dc(),
                &source,
                0,
                &blend,
                ULW_ALPHA,
            )
        };
        if updated == 0 {
            Err(win32_error("The overlay could not be painted"))
        } else {
            unsafe { ShowWindow(self.handle, SW_SHOWNOACTIVATE) };
            Ok(())
        }
    }

    /// Drains whatever the queue holds without waiting for more, so a
    /// quiet desktop costs nothing and a DPI change is still seen.
    pub(crate) fn pump(&self) {
        let mut message: MSG = unsafe { std::mem::zeroed() };
        let mut guard = 0;
        while guard < 64
            && unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 }
        {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            guard += 1;
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for OverlayWindow {
    fn drop(&mut self) {
        unsafe { DestroyWindow(self.handle) };
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GWL_STYLE, GetWindowLongPtrW, WS_VISIBLE};

    #[test]
    fn empty_frame_hides_previous_overlay_and_next_frame_restores_it() {
        let window = OverlayWindow::create().unwrap();
        unsafe { ShowWindow(window.handle, SW_SHOWNOACTIVATE) };
        window.present(0, 0, 1, 1, &[0xffffffff]).unwrap();
        assert_ne!(
            unsafe { GetWindowLongPtrW(window.handle, GWL_STYLE) } as u32 & WS_VISIBLE,
            0
        );
        window.present(0, 0, 0, 0, &[]).unwrap();
        assert_eq!(
            unsafe { GetWindowLongPtrW(window.handle, GWL_STYLE) } as u32 & WS_VISIBLE,
            0
        );
        window.present(0, 0, 1, 1, &[0xffffffff]).unwrap();
        assert_ne!(
            unsafe { GetWindowLongPtrW(window.handle, GWL_STYLE) } as u32 & WS_VISIBLE,
            0
        );
    }
}
