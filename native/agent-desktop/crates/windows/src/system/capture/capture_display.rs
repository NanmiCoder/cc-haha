//! Legacy display capture via `BitBlt` from the screen DC.
//!
//! Public index 0 is the primary display — the `FullScreen` target maps here,
//! never to the virtual-screen span. Monitor origins may be negative on
//! multi-monitor desktops; the blit source uses those coordinates as-is.

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, ImageBuffer, ImageFormat, Rect};

pub(crate) use super::gdi_surface::gdi_balance;
use super::gdi_surface::{self, GdiDcPair};
use super::png_codec::encode_bgra_to_png;
use crate::system::display::display_at;
use crate::system::runtime::hresult::win32_last_error;

/// Captures the display at the public enumeration index into a PNG buffer.
///
/// Index 0 is the primary (`FullScreen`). Dimensions and scale come from the
/// same enumeration the blit targets — never from literals.
pub(crate) fn capture_display_at(
    index: usize,
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    deadline.ensure_remaining()?;
    let display = display_at(index, deadline)?;
    capture_display_bounds(display.bounds, display.scale, deadline)
}

pub(in crate::system) fn capture_display_bounds(
    bounds: Rect,
    scale_factor: f64,
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    deadline.ensure_remaining()?;
    let (width, height, origin_x, origin_y) = display_capture_geometry(bounds)?;
    deadline.ensure_remaining()?;
    let pixels = bitblt_screen_bgra(origin_x, origin_y, width, height)?;
    let stride = width
        .checked_mul(4)
        .ok_or_else(|| AdapterError::internal("display capture stride overflowed"))?;
    let png = encode_bgra_to_png(&pixels, width, height, stride, deadline)?;
    Ok(ImageBuffer {
        data: png,
        format: ImageFormat::Png,
        width,
        height,
        scale_factor,
    })
}

pub(in crate::system) fn display_capture_geometry(
    bounds: Rect,
) -> Result<(u32, u32, i32, i32), AdapterError> {
    if !bounds.width.is_finite()
        || !bounds.height.is_finite()
        || !bounds.x.is_finite()
        || !bounds.y.is_finite()
    {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Display bounds must be finite",
        ));
    }
    if bounds.width <= 0.0 || bounds.height <= 0.0 {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Cannot capture a zero-area display",
        ));
    }
    let width = bounds.width as i32;
    let height = bounds.height as i32;
    if width <= 0 || height <= 0 {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Cannot capture a zero-area display",
        ));
    }
    let (width, height) = (width as u32, height as u32);
    gdi_surface::reject_oversized_capture(width, height)?;
    Ok((width, height, bounds.x as i32, bounds.y as i32))
}

fn bitblt_screen_bgra(
    origin_x: i32,
    origin_y: i32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, AdapterError> {
    let surface = DibSection::create(width as i32, height as i32)?;
    #[cfg(test)]
    if fail_after_alloc::is_active() {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "forced capture failure after GDI allocation",
        ));
    }
    use windows_sys::Win32::Graphics::Gdi::{BitBlt, SRCCOPY};
    if unsafe {
        BitBlt(
            surface.dc_pair.memory_dc,
            0,
            0,
            width as i32,
            height as i32,
            surface.dc_pair.screen_dc,
            origin_x,
            origin_y,
            SRCCOPY,
        )
    } == 0
    {
        return Err(win32_last_error("BitBlt failed for display capture"));
    }
    surface.into_bgra()
}

struct DibSection {
    dc_pair: GdiDcPair,
    bitmap: *mut core::ffi::c_void,
    previous: *mut core::ffi::c_void,
    bits: *mut u8,
    width: i32,
    height: i32,
}

impl DibSection {
    fn create(width: i32, height: i32) -> Result<Self, AdapterError> {
        use windows_sys::Win32::Graphics::Gdi::{
            CreateDIBSection, DIB_RGB_COLORS, DeleteObject, SelectObject,
        };

        let dc_pair = GdiDcPair::create("display capture")?;
        let info = gdi_surface::top_down_bgra_bitmap_info(width, height);
        let mut bits_ptr = std::ptr::null_mut();
        let bitmap = unsafe {
            CreateDIBSection(
                dc_pair.memory_dc,
                &info,
                DIB_RGB_COLORS,
                &mut bits_ptr,
                std::ptr::null_mut(),
                0,
            )
        };
        if bitmap.is_null() || bits_ptr.is_null() {
            return Err(win32_last_error(
                "CreateDIBSection failed for display capture",
            ));
        }
        gdi_balance::acquire();
        let previous = unsafe { SelectObject(dc_pair.memory_dc, bitmap) };
        if previous.is_null() {
            let error = win32_last_error("SelectObject failed for display capture");
            if unsafe { DeleteObject(bitmap) } != 0 {
                gdi_balance::release();
            }
            return Err(error);
        }
        Ok(Self {
            dc_pair,
            bitmap,
            previous,
            bits: bits_ptr.cast(),
            width,
            height,
        })
    }

    fn into_bgra(self) -> Result<Vec<u8>, AdapterError> {
        let bytes = gdi_surface::checked_bgra_byte_len(self.width, self.height)?;
        let mut pixels = vec![0u8; bytes];
        unsafe {
            std::ptr::copy_nonoverlapping(self.bits, pixels.as_mut_ptr(), bytes);
        }
        Ok(pixels)
    }
}

impl Drop for DibSection {
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
#[path = "capture_display_tests.rs"]
mod tests;
