use crate::types::{AdImageBuffer, AdImageFormat};
use std::ptr;

/// Borrowed pointer to the image bytes; valid until the buffer is freed.
/// Returns null if `buf` is null.
///
/// # Safety
/// `buf` must be null or returned by `ad_screenshot`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_image_buffer_data(buf: *const AdImageBuffer) -> *const u8 {
    if buf.is_null() {
        return ptr::null();
    }
    let buf_ref: &AdImageBuffer = unsafe { &*buf };
    buf_ref.data.as_ptr()
}

/// Byte length of the buffer returned by `ad_image_buffer_data`.
/// Always consistent with the actual allocation (no C-mutable mismatch).
///
/// # Safety
/// `buf` must be null or returned by `ad_screenshot`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_image_buffer_size(buf: *const AdImageBuffer) -> u64 {
    if buf.is_null() {
        return 0;
    }
    let buf_ref: &AdImageBuffer = unsafe { &*buf };
    buf_ref.data.len() as u64
}

/// Pixel width of the image.
///
/// # Safety
/// `buf` must be null or returned by `ad_screenshot`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_image_buffer_width(buf: *const AdImageBuffer) -> u32 {
    if buf.is_null() {
        return 0;
    }
    let buf_ref: &AdImageBuffer = unsafe { &*buf };
    buf_ref.width
}

/// Pixel height of the image.
///
/// # Safety
/// `buf` must be null or returned by `ad_screenshot`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_image_buffer_height(buf: *const AdImageBuffer) -> u32 {
    if buf.is_null() {
        return 0;
    }
    let buf_ref: &AdImageBuffer = unsafe { &*buf };
    buf_ref.height
}

/// Encoding format of the image bytes. Defaults to `PNG` on a null
/// handle — callers must still null-check.
///
/// # Safety
/// `buf` must be null or returned by `ad_screenshot`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_image_buffer_format(buf: *const AdImageBuffer) -> AdImageFormat {
    if buf.is_null() {
        return AdImageFormat::Png;
    }
    let buf_ref: &AdImageBuffer = unsafe { &*buf };
    buf_ref.format
}

/// Point-to-pixel scale factor for the captured display or window.
///
/// # Safety
/// `buf` must be null or returned by `ad_screenshot`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_image_buffer_scale_factor(buf: *const AdImageBuffer) -> f64 {
    if buf.is_null() {
        return 1.0;
    }
    let buf_ref: &AdImageBuffer = unsafe { &*buf };
    buf_ref.scale_factor
}
