use crate::ffi_try::trap_panic_void;
use crate::types::AdImageBuffer;

/// Frees the image buffer allocated by `ad_screenshot`.
///
/// # Safety
/// `buf` must be null or a pointer previously returned by `ad_screenshot`.
/// Double-free is undefined behavior.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_image_buffer_free(buf: *mut AdImageBuffer) {
    trap_panic_void(|| unsafe {
        if buf.is_null() {
            return;
        }
        drop(Box::from_raw(buf));
    })
}
