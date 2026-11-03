//! Legacy window capture via `PrintWindow` and a pump-liveness pre-probe.
//!
//! Call order owned by the caller: corroborate window identity first, then
//! invoke [`capture_window`]. This module refuses a destroyed handle before
//! the pump probe so a gone window is not mislabelled `APP_UNRESPONSIVE`,
//! then probes responsiveness, then issues `PrintWindow`. The native
//! `PrintWindow` symbol is imported from user32.dll locally because the
//! windows-sys binding sits behind Win32_Storage_Xps, which this crate does
//! not enable.

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, ImageBuffer, ImageFormat};

pub(crate) use super::gdi_surface::gdi_balance;
use super::gdi_surface::{self, GdiDcPair};
use super::png_codec::encode_bgra_to_png;
use crate::system::runtime::hresult::win32_last_error;
use crate::system::window::window_enum::{WindowHandle, window_is_responsive};

/// Undocumented `PrintWindow` flag (Windows 8.1+) that asks the target for a
/// full composited frame rather than a client-only `WM_PRINT` pass. Not in
/// the official parameter table — only `PW_CLIENTONLY` is documented there.
/// A22-2 measured non-black frames with this flag on this project's GDI
/// fixture stacks.
const PW_RENDERFULLCONTENT: u32 = 0x0000_0002;

#[link(name = "user32")]
unsafe extern "system" {
    fn PrintWindow(
        hwnd: WindowHandle,
        hdcblt: windows_sys::Win32::Graphics::Gdi::HDC,
        nflags: u32,
    ) -> i32;
}

const MINIMIZED_ORIGIN_SENTINEL: i32 = -32_000;

/// Captures `handle` into a PNG [`ImageBuffer`] using GDI `PrintWindow`.
///
/// Requires the caller to have already verified window identity. Performs the
/// pump-liveness pre-probe immediately before the native capture call.
pub(crate) fn capture_window(
    handle: WindowHandle,
    scale_factor: f64,
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    deadline.ensure_remaining()?;
    ensure_handle_alive(handle)?;
    ensure_window_is_pumping(handle)?;
    deadline.ensure_remaining()?;
    let (width, height) = window_capture_size(handle)?;
    let pixels = print_window_bgra(handle, width, height)?;
    let stride = width
        .checked_mul(4)
        .ok_or_else(|| AdapterError::internal("window capture stride overflowed"))?;
    let png = encode_bgra_to_png(&pixels, width, height, stride, deadline)?;
    Ok(ImageBuffer {
        data: png,
        format: ImageFormat::Png,
        width,
        height,
        scale_factor,
    })
}

fn ensure_handle_alive(handle: WindowHandle) -> Result<(), AdapterError> {
    if crate::tree::automation::window_exists(handle as isize) {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::StaleRef,
        "The window handle no longer addresses a live window",
    )
    .with_suggestion("Run 'list-windows' and 'screenshot' to refresh identifiers, then retry.")
    .with_platform_detail(format!(
        "HWND 0x{:X} failed the pre-capture existence check",
        handle as usize
    )))
}

fn ensure_window_is_pumping(handle: WindowHandle) -> Result<(), AdapterError> {
    if window_is_responsive(handle) {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Target window is not processing messages, so PrintWindow would block",
    )
    .with_suggestion("Wait for the application to recover, then retry the screenshot"))
}

fn window_capture_size(handle: WindowHandle) -> Result<(u32, u32), AdapterError> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic};

    let mut rect = RECT::default();
    if unsafe { GetWindowRect(handle, &mut rect) } == 0 {
        return Err(win32_last_error(
            "GetWindowRect failed before window capture",
        ));
    }
    if unsafe { IsIconic(handle) } != 0
        || rect.left <= MINIMIZED_ORIGIN_SENTINEL
        || rect.top <= MINIMIZED_ORIGIN_SENTINEL
    {
        return Err(
            AdapterError::new(ErrorCode::InvalidArgs, "Cannot capture a minimized window")
                .with_suggestion("Restore the window, then retry the screenshot"),
        );
    }
    let width = rect.right.saturating_sub(rect.left);
    let height = rect.bottom.saturating_sub(rect.top);
    if width <= 0 || height <= 0 {
        return Err(
            AdapterError::new(ErrorCode::InvalidArgs, "Cannot capture a zero-area window")
                .with_suggestion("Restore or resize the window, then retry the screenshot"),
        );
    }
    let (width, height) = (width as u32, height as u32);
    gdi_surface::reject_oversized_capture(width, height)?;
    Ok((width, height))
}

/// Prefer [`PW_RENDERFULLCONTENT`] for a composited frame; when that yields an
/// empty buffer (common for WS_POPUP windows outside DWM redirection), retry
/// with bare flags so WM_PRINTCLIENT can paint the DC.
fn print_window_bgra(
    handle: WindowHandle,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, AdapterError> {
    #[cfg(test)]
    if fail_after_alloc::is_active() {
        let _surface = CaptureSurface::create(width as i32, height as i32)?;
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "forced capture failure after GDI allocation",
        ));
    }
    let full = capture_with_flags(handle, width, height, PW_RENDERFULLCONTENT)?;
    if !frame_appears_empty(&full) && !fail_after_fullcontent_is_active() {
        return Ok(full);
    }
    capture_with_flags(handle, width, height, 0)
}

#[cfg(not(test))]
fn fail_after_fullcontent_is_active() -> bool {
    false
}

#[cfg(test)]
fn fail_after_fullcontent_is_active() -> bool {
    fail_after_fullcontent::is_active()
}

fn capture_with_flags(
    handle: WindowHandle,
    width: u32,
    height: u32,
    flags: u32,
) -> Result<Vec<u8>, AdapterError> {
    #[cfg(test)]
    if flags == 0 {
        bare_retry_observed::mark();
    }
    let surface = CaptureSurface::create(width as i32, height as i32)?;
    if unsafe { PrintWindow(handle, surface.dc_pair.memory_dc, flags) } == 0 {
        return Err(win32_last_error("PrintWindow failed"));
    }
    surface.read_bgra()
}

fn frame_appears_empty(pixels: &[u8]) -> bool {
    !pixels
        .chunks_exact(4)
        .any(|px| px[0] != 0 || px[1] != 0 || px[2] != 0)
}

/// Device-compatible bitmap surface matching the A22-2 probe path:
/// `CreateCompatibleBitmap` + `PrintWindow` + `GetDIBits`. A DIB-section
/// target can stay black under `PW_RENDERFULLCONTENT` even when the same
/// call into a compatible bitmap yields the painted frame.
struct CaptureSurface {
    dc_pair: GdiDcPair,
    bitmap: *mut core::ffi::c_void,
    previous: *mut core::ffi::c_void,
    width: i32,
    height: i32,
}

impl CaptureSurface {
    fn create(width: i32, height: i32) -> Result<Self, AdapterError> {
        use windows_sys::Win32::Graphics::Gdi::{
            CreateCompatibleBitmap, DeleteObject, SelectObject,
        };

        let dc_pair = GdiDcPair::create("window capture")?;
        let bitmap = unsafe { CreateCompatibleBitmap(dc_pair.screen_dc, width, height) };
        if bitmap.is_null() {
            return Err(win32_last_error(
                "CreateCompatibleBitmap failed for window capture",
            ));
        }
        gdi_balance::acquire();
        let previous = unsafe { SelectObject(dc_pair.memory_dc, bitmap) };
        if previous.is_null() {
            let error = win32_last_error("SelectObject failed for window capture");
            if unsafe { DeleteObject(bitmap) } != 0 {
                gdi_balance::release();
            }
            return Err(error);
        }
        Ok(Self {
            dc_pair,
            bitmap,
            previous,
            width,
            height,
        })
    }

    fn read_bgra(self) -> Result<Vec<u8>, AdapterError> {
        use windows_sys::Win32::Graphics::Gdi::{DIB_RGB_COLORS, GetDIBits};

        let mut info = gdi_surface::top_down_bgra_bitmap_info(self.width, self.height);
        let byte_len = gdi_surface::checked_bgra_byte_len(self.width, self.height)?;
        let mut pixels = vec![0u8; byte_len];
        let copied = unsafe {
            GetDIBits(
                self.dc_pair.memory_dc,
                self.bitmap,
                0,
                self.height as u32,
                pixels.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        if copied == 0 {
            return Err(win32_last_error("GetDIBits failed after PrintWindow"));
        }
        Ok(pixels)
    }
}

impl Drop for CaptureSurface {
    fn drop(&mut self) {
        gdi_surface::restore_selected_bitmap(self.dc_pair.memory_dc, self.previous, self.bitmap);
    }
}

#[cfg(test)]
pub(in crate::system) mod fail_after_alloc {
    use std::cell::Cell;

    thread_local! {
        static ACTIVE: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn is_active() -> bool {
        ACTIVE.with(Cell::get)
    }

    pub(super) fn with<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&ACTIVE, true, run)
    }
}

#[cfg(test)]
pub(in crate::system) mod fail_after_fullcontent {
    use std::cell::Cell;

    thread_local! {
        static ACTIVE: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn is_active() -> bool {
        ACTIVE.with(Cell::get)
    }

    pub(super) fn with<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&ACTIVE, true, run)
    }
}

#[cfg(test)]
pub(in crate::system) mod bare_retry_observed {
    use std::cell::Cell;

    thread_local! {
        static SEEN: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn mark() {
        SEEN.with(|cell| cell.set(true));
    }

    pub(super) fn take() -> bool {
        SEEN.with(|cell| {
            let seen = cell.get();
            cell.set(false);
            seen
        })
    }

    pub(super) fn reset() {
        SEEN.with(|cell| cell.set(false));
    }
}

#[cfg(test)]
#[path = "capture_window_tests.rs"]
mod tests;
