//! Shared GDI screen/memory device-context pairing for the two Legacy
//! capture backends.
//!
//! `capture_window.rs` selects a compatible bitmap into the memory DC and
//! reads it back with `GetDIBits`; `capture_display.rs` selects a DIB
//! section and reads its mapped bits directly. Those two bitmap shapes stay
//! distinct on purpose — folding them into one type would fit neither read
//! path. What both surfaces do identically is open a screen DC, pair it with
//! a compatible memory DC, and tear the pair down in the same order; that
//! pairing, the GDI-object balance counter, and the `GetLastError` mapping
//! live here once instead of twice.

use agent_desktop_core::{AdapterError, ErrorCode};
use windows_sys::Win32::Graphics::Gdi::{BI_RGB, BITMAPINFO, BITMAPINFOHEADER, HDC};

use crate::system::runtime::hresult::win32_last_error;

const MAX_CAPTURE_PIXELS: u64 = 64 * 1024 * 1024;

/// Refuses a capture whose pixel byte count would overflow the `i32`
/// arithmetic a raw GDI write depends on, before either backend creates any
/// GDI resource for it. `GetWindowRect`/display bounds are not clamped to a
/// sane size by Windows, so this is reachable from ordinary input, not just
/// adversarial input.
pub(in crate::system) fn reject_oversized_capture(
    width: u32,
    height: u32,
) -> Result<(), AdapterError> {
    let byte_len = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|area| area.checked_mul(4));
    let pixels = u64::from(width).checked_mul(u64::from(height));
    match (byte_len, pixels) {
        (Some(len), Some(pixels)) if len <= i32::MAX as u64 && pixels <= MAX_CAPTURE_PIXELS => {
            Ok(())
        }
        _ => Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("Cannot capture a {width}x{height} region: pixel buffer size overflows"),
        )
        .with_suggestion("Capture a smaller window or region, then retry the screenshot")),
    }
}

/// Computes a BGRA pixel buffer's byte length with non-wrapping arithmetic.
///
/// `width` and `height` are validated non-negative by the caller before a
/// surface is built from them; this still returns `Result` rather than
/// panicking so a future caller that skips that validation fails closed
/// instead of wrapping into an undersized allocation.
pub(in crate::system) fn checked_bgra_byte_len(
    width: i32,
    height: i32,
) -> Result<usize, AdapterError> {
    i64::from(width)
        .checked_mul(i64::from(height))
        .and_then(|area| area.checked_mul(4))
        .and_then(|len| usize::try_from(len).ok())
        .ok_or_else(|| AdapterError::internal("capture buffer size overflowed"))
}

pub(in crate::system) fn top_down_bgra_bitmap_info(width: i32, height: i32) -> BITMAPINFO {
    BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        },
        ..Default::default()
    }
}

/// The screen DC and its paired compatible memory DC, released together.
///
/// Owns exactly the two GDI objects every Legacy capture surface opens
/// before selecting its own bitmap into `memory_dc`; the bitmap stays with
/// the caller, since a compatible bitmap and a DIB section are read back
/// through different APIs.
pub(in crate::system) struct GdiDcPair {
    pub(in crate::system) screen_dc: HDC,
    pub(in crate::system) memory_dc: HDC,
}

impl GdiDcPair {
    pub(in crate::system) fn create(context: &str) -> Result<Self, AdapterError> {
        use windows_sys::Win32::Graphics::Gdi::{CreateCompatibleDC, GetDC, ReleaseDC};

        let screen_dc = unsafe { GetDC(std::ptr::null_mut()) };
        if screen_dc.is_null() {
            return Err(win32_last_error(&format!("GetDC failed for {context}")));
        }
        gdi_balance::acquire();
        let memory_dc = unsafe { CreateCompatibleDC(screen_dc) };
        if memory_dc.is_null() {
            unsafe { ReleaseDC(std::ptr::null_mut(), screen_dc) };
            gdi_balance::release();
            return Err(win32_last_error(&format!(
                "CreateCompatibleDC failed for {context}"
            )));
        }
        gdi_balance::acquire();
        Ok(Self {
            screen_dc,
            memory_dc,
        })
    }
}

impl Drop for GdiDcPair {
    fn drop(&mut self) {
        use windows_sys::Win32::Graphics::Gdi::{DeleteDC, ReleaseDC};
        unsafe {
            DeleteDC(self.memory_dc);
            gdi_balance::release();
            ReleaseDC(std::ptr::null_mut(), self.screen_dc);
            gdi_balance::release();
        }
    }
}

/// Restores the memory DC's prior GDI selection, deletes `bitmap`, and
/// decrements the balance counter acquired when the bitmap was selected.
///
/// Runs from `Drop`, so it cannot return an error and must not panic. A
/// bitmap still selected into a DC cannot be deleted, so if restoring
/// `previous` fails the balance counter is deliberately left un-decremented
/// instead of being released for an object that is still alive: the leak
/// becomes observable as a non-zero `gdi_balance::live()` rather than
/// silently disappearing behind an unconditional release.
pub(in crate::system) fn restore_selected_bitmap(
    memory_dc: HDC,
    previous: *mut core::ffi::c_void,
    bitmap: *mut core::ffi::c_void,
) {
    use windows_sys::Win32::Graphics::Gdi::{DeleteObject, SelectObject};
    let restored = unsafe { SelectObject(memory_dc, previous) };
    if restored.is_null() {
        return;
    }
    let deleted = unsafe { DeleteObject(bitmap) };
    if deleted == 0 {
        return;
    }
    gdi_balance::release();
}

pub(crate) mod gdi_balance {
    use std::cell::Cell;

    thread_local! {
        static LIVE: Cell<i32> = const { Cell::new(0) };
    }

    pub(crate) fn acquire() {
        LIVE.with(|cell| cell.set(cell.get() + 1));
    }

    pub(crate) fn release() {
        LIVE.with(|cell| cell.set(cell.get() - 1));
    }

    #[cfg(test)]
    pub(crate) fn live() -> i32 {
        LIVE.with(Cell::get)
    }

    #[cfg(test)]
    pub(crate) fn reset() {
        LIVE.with(|cell| cell.set(0));
    }
}

#[cfg(test)]
#[path = "gdi_surface_tests.rs"]
mod tests;
