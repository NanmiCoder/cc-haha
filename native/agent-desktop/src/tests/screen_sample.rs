//! Counting pixels of one exact colour on the live screen.
//!
//! The overlay is verified by painting it a colour nothing else on the
//! desktop uses and counting exact matches, rather than by counting pixels
//! that changed. Change-counting was tried first and is not evidence: a
//! control run with no overlay at all changed eight of forty-one sampled
//! pixels from ordinary desktop churn, which is more than the overlay itself
//! had moved.
//!
//! `CAPTUREBLT` is required. Without it a layered window is composited out of
//! the copy, so the sampler would read the desktop underneath the overlay and
//! report zero every time — a check that always passes after teardown and
//! always fails before it.

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, CreateCompatibleBitmap, CreateCompatibleDC,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SRCCOPY, SelectObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

/// How many pixels of the primary screen are exactly this colour, or `None`
/// when the screen could not be read at all.
///
/// The distinction is the whole point. A sampler that answered `0` for a
/// failed capture would satisfy every "the overlay is gone" wait on its first
/// poll, so a transient GDI fault — a desktop switch, handle pressure under
/// load — would read as a successful teardown. That is the same
/// cannot-distinguish-success-from-failure shape this module's header warns
/// about for `CAPTUREBLT`, and returning a count for something never looked at
/// would reintroduce it one layer up.
pub fn pixels_matching(red: u8, green: u8, blue: u8) -> Option<usize> {
    let width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    if width <= 0 || height <= 0 {
        return None;
    }
    let pixels = capture(width, height)?;
    Some(
        pixels
            .chunks_exact(4)
            .filter(|pixel| pixel[0] == blue && pixel[1] == green && pixel[2] == red)
            .count(),
    )
}

fn capture(width: i32, height: i32) -> Option<Vec<u8>> {
    let screen = unsafe { GetDC(std::ptr::null_mut::<HWND>() as HWND) };
    if screen.is_null() {
        return None;
    }
    let memory = unsafe { CreateCompatibleDC(screen) };
    let bitmap = unsafe { CreateCompatibleBitmap(screen, width, height) };
    let pixels = if memory.is_null() || bitmap.is_null() {
        None
    } else {
        read_into_buffer(screen, memory, bitmap, width, height)
    };

    unsafe {
        if !bitmap.is_null() {
            DeleteObject(bitmap.cast());
        }
        if !memory.is_null() {
            DeleteDC(memory);
        }
        ReleaseDC(std::ptr::null_mut::<HWND>() as HWND, screen);
    }
    pixels
}

/// Copies the screen and reads it back as bytes. The negative `biHeight`
/// asks for a top-down buffer, which matters only because it keeps the row
/// order predictable while scanning.
fn read_into_buffer(
    screen: windows_sys::Win32::Graphics::Gdi::HDC,
    memory: windows_sys::Win32::Graphics::Gdi::HDC,
    bitmap: windows_sys::Win32::Graphics::Gdi::HBITMAP,
    width: i32,
    height: i32,
) -> Option<Vec<u8>> {
    let previous = unsafe { SelectObject(memory, bitmap.cast()) };
    let copied = unsafe {
        windows_sys::Win32::Graphics::Gdi::BitBlt(
            memory,
            0,
            0,
            width,
            height,
            screen,
            0,
            0,
            SRCCOPY | CAPTUREBLT,
        )
    };
    let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    let mut buffer = vec![0u8; (width as usize) * (height as usize) * 4];
    let rows = unsafe {
        GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            buffer.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe { SelectObject(memory, previous) };

    if copied == 0 || rows == 0 {
        return None;
    }
    Some(buffer)
}
