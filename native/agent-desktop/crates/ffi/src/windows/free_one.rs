use crate::ffi_try::trap_panic_void;
use crate::types::AdExactWindowInfo;

/// Releases every owned string inside one exact window value.
///
/// # Safety
/// `win` must be null or point to a value written by `ad_launch_app_exact`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_release_exact_window_fields(win: *mut AdExactWindowInfo) {
    trap_panic_void(|| unsafe {
        if let Some(window) = win.as_mut() {
            crate::convert::window::free_exact_window_info_fields(window);
        }
    })
}
