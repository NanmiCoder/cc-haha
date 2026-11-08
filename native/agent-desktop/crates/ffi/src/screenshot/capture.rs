use crate::AdAdapter;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::types::{
    AdExactWindowInfo, AdImageBuffer, AdImageFormat, AdScreenshotKind, AdScreenshotTarget,
};
use agent_desktop_core::{ImageFormat, ScreenshotTarget as CoreScreenshotTarget};
use std::ptr;

/// Allocates and returns an opaque `AdImageBuffer`. The handle owns its
/// byte buffer; inspect it through `ad_image_buffer_data` /
/// `ad_image_buffer_size` / `ad_image_buffer_format` / `_width` / `_height`
/// and free it with `ad_image_buffer_free`.
///
/// # Safety
/// `adapter` and `target` must be valid pointers. `out` must be a valid
/// writable `*mut *mut AdImageBuffer`. On error `*out` is null and
/// last-error is set.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_screenshot(
    adapter: *const AdAdapter,
    target: *const AdScreenshotTarget,
    out: *mut *mut AdImageBuffer,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        *out = ptr::null_mut();
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(target, c"target is null");
        let t = &*target;
        let kind = match AdScreenshotKind::from_c(t.kind) {
            Some(k) => k,
            None => {
                set_last_error(&agent_desktop_core::AdapterError::new(
                    agent_desktop_core::ErrorCode::InvalidArgs,
                    "invalid screenshot kind discriminant",
                ));
                return AdResult::ErrInvalidArgs;
            }
        };
        let core_target = match kind {
            AdScreenshotKind::Screen => match usize::try_from(t.screen_index) {
                Ok(index) if index <= 10_000 => CoreScreenshotTarget::Screen(index),
                _ => {
                    let error = agent_desktop_core::AdapterError::new(
                        agent_desktop_core::ErrorCode::InvalidArgs,
                        "screen_index exceeds the supported display limit",
                    );
                    set_last_error(&error);
                    return AdResult::ErrInvalidArgs;
                }
            },
            AdScreenshotKind::FullScreen => CoreScreenshotTarget::FullScreen,
        };
        capture(adapter, core_target, out)
    })
}

/// Captures one generation-pinned exact window.
///
/// # Safety
/// `adapter`, `window`, and `out` must be valid pointers. The returned image
/// must be freed with `ad_image_buffer_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_screenshot_window_exact(
    adapter: *const AdAdapter,
    window: *const AdExactWindowInfo,
    out: *mut *mut AdImageBuffer,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        *out = ptr::null_mut();
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(window, c"window is null");
        let window = match crate::windows::ad_exact_window_to_core(&*window) {
            Ok(window) => window,
            Err(error) => {
                set_last_error(&error);
                return crate::error::last_error_code();
            }
        };
        capture(adapter, CoreScreenshotTarget::ExactWindow(window), out)
    })
}

unsafe fn capture(
    adapter: *const AdAdapter,
    target: CoreScreenshotTarget,
    out: *mut *mut AdImageBuffer,
) -> AdResult {
    let adapter = crate::adapter::acquire_adapter!(adapter);
    let deadline = crate::operation::operation_deadline!();
    match adapter.inner.screenshot(target, deadline) {
        Ok(image) => {
            if let Err(error) = crate::resource::validate_image(&image) {
                set_last_error(&error);
                return crate::error::last_error_code();
            }
            let buffer = Box::new(AdImageBuffer {
                data: image.data.into_boxed_slice(),
                width: image.width,
                height: image.height,
                format: match image.format {
                    ImageFormat::Png => AdImageFormat::Png,
                    ImageFormat::Jpg => AdImageFormat::Jpg,
                },
                scale_factor: image.scale_factor,
            });
            unsafe { *out = Box::into_raw(buffer) };
            AdResult::Ok
        }
        Err(error) => {
            set_last_error(&error);
            crate::error::last_error_code()
        }
    }
}
