//! The label's text, and the one place GDI is allowed to draw.
//!
//! The text is set in Segoe UI at semibold and measured in that same font,
//! so the pill core sizes from the measurement fits what is drawn, and is
//! centred in it across and down.
//!
//! GDI writes RGB and leaves the alpha byte at zero, which is why every other
//! element is composited by hand. Text is the exception because a glyph
//! rasterizer is not something to hand-roll: it is drawn into a scratch
//! surface, then copied into the overlay's buffer at full opacity, over a
//! bubble body already composited opaque. Forcing alpha across that inset
//! rectangle is correct rather than a workaround — the rounded corners it
//! would otherwise square off are outside it.
//!
//! The font is created with `ANTIALIASED_QUALITY` rather than ClearType,
//! because subpixel anti-aliasing composited through `UpdateLayeredWindow`
//! against transparency fringes with colour.

#[cfg(target_os = "windows")]
pub(crate) use imp::{draw_label, measure_label};

#[cfg(all(test, target_os = "windows"))]
#[path = "text_tests.rs"]
mod tests;

#[cfg(not(target_os = "windows"))]
pub(crate) fn measure_label(_label: &str, _points: f64) -> Option<f64> {
    None
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn draw_label(
    _surface: &mut super::raster::Surface,
    _rect: &agent_desktop_core::Rect,
    _label: &str,
    _rgb: [f64; 3],
    _points: f64,
) {
}

#[cfg(target_os = "windows")]
mod imp {
    use crate::system::cursor_overlay::dib::Dib;
    use crate::system::cursor_overlay::raster::Surface;
    use crate::system::cursor_overlay::wide::wide;
    use agent_desktop_core::Rect;
    use windows_sys::Win32::Foundation::SIZE;
    use windows_sys::Win32::Graphics::Gdi::{
        ANTIALIASED_QUALITY, CLIP_DEFAULT_PRECIS, CreateCompatibleDC, CreateFontW, DEFAULT_CHARSET,
        DEFAULT_PITCH, DT_CENTER, DT_END_ELLIPSIS, DT_SINGLELINE, DT_VCENTER, DeleteDC,
        DeleteObject, DrawTextW, FW_SEMIBOLD, GdiFlush, GetTextExtentPoint32W, HFONT,
        OUT_DEFAULT_PRECIS, SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
    };

    fn label_font(points: f64) -> HFONT {
        let face = wide("Segoe UI");
        unsafe {
            CreateFontW(
                -(points.round() as i32),
                0,
                0,
                0,
                FW_SEMIBOLD as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                ANTIALIASED_QUALITY as u32,
                DEFAULT_PITCH as u32,
                face.as_ptr(),
            )
        }
    }

    /// The label's width in pixels when set at `points`, or `None` when it
    /// cannot be measured; a label that cannot be measured is not drawn.
    pub(crate) fn measure_label(label: &str, points: f64) -> Option<f64> {
        let text: Vec<u16> = label.encode_utf16().collect();
        let length = i32::try_from(text.len()).ok()?;
        let memory = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
        if memory.is_null() {
            return None;
        }
        let font = label_font(points);
        let previous = unsafe { SelectObject(memory, font) };
        let mut size = SIZE { cx: 0, cy: 0 };
        let measured = unsafe { GetTextExtentPoint32W(memory, text.as_ptr(), length, &mut size) };
        unsafe {
            SelectObject(memory, previous);
            DeleteObject(font);
            DeleteDC(memory);
        }
        (measured != 0).then(|| f64::from(size.cx))
    }

    fn colorref(rgb: [f64; 3]) -> u32 {
        let channel = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u32;
        channel(rgb[0]) | (channel(rgb[1]) << 8) | (channel(rgb[2]) << 16)
    }

    /// Not optional. GDI batches drawing calls, so `DrawTextW` returning is
    /// no guarantee its output has reached the DIB section's bits yet.
    /// `GdiFlush` is the documented way to force that before the buffer is
    /// read directly; without it the read below can come back blank or
    /// partial, non-deterministically, with no error and no way to tell a
    /// successful draw from an unflushed one.
    fn flush_before_reading_bits() {
        unsafe {
            GdiFlush();
        }
    }

    pub(crate) fn draw_label(
        surface: &mut Surface,
        rect: &Rect,
        label: &str,
        rgb: [f64; 3],
        points: f64,
    ) {
        let width = rect.width.ceil() as i32;
        let height = rect.height.ceil() as i32;
        if width <= 0 || height <= 0 || label.is_empty() {
            return;
        }

        let Some(mut dib) = Dib::create(width, height) else {
            return;
        };
        let memory = dib.dc();
        let scratch = dib.pixels();
        for y in 0..height {
            for x in 0..width {
                let source = surface
                    .pixel_at(rect.x as i32 + x, rect.y as i32 + y)
                    .unwrap_or(0);
                scratch[(y as usize) * (width as usize) + (x as usize)] = source & 0x00FF_FFFF;
            }
        }

        let font = label_font(points);
        let previous_font = unsafe { SelectObject(memory, font) };
        unsafe {
            SetBkMode(memory, TRANSPARENT as i32);
            SetTextColor(memory, colorref(rgb));
        }

        let mut text = wide(label);
        let mut bounds = windows_sys::Win32::Foundation::RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        };
        unsafe {
            DrawTextW(
                memory,
                text.as_mut_ptr(),
                -1,
                &mut bounds,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
        }

        flush_before_reading_bits();

        for y in 0..height {
            for x in 0..width {
                let value = scratch[(y as usize) * (width as usize) + (x as usize)];
                let target_x = rect.x as i32 + x;
                let target_y = rect.y as i32 + y;
                if target_x < 0
                    || target_y < 0
                    || target_x >= surface.width
                    || target_y >= surface.height
                {
                    continue;
                }
                let index = (target_y as usize) * (surface.width as usize) + (target_x as usize);
                surface.pixels[index] = 0xFF00_0000 | (value & 0x00FF_FFFF);
            }
        }

        unsafe {
            SelectObject(memory, previous_font);
            DeleteObject(font);
        }
    }
}
