use crate::AdAdapter;
use crate::convert::string::{free_c_string, required_adapter_string, string_to_c};
use crate::error::{self, AdResult};
use crate::ffi_try::{trap_panic, trap_panic_void};
use agent_desktop_core::{ClipboardContent, ClipboardFormat};
use std::os::raw::c_char;

/// Reads the current clipboard text and writes an owned C string into
/// `*out`. The caller must free the returned pointer with
/// `ad_free_string`. On error `*out` is left null.
///
/// # Safety
/// `adapter` must be a non-null pointer returned by `ad_adapter_create`.
/// `out` must be a non-null writable `*mut *mut c_char`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_get_clipboard(
    adapter: *const AdAdapter,
    out: *mut *mut c_char,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        *out = std::ptr::null_mut();
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let deadline = crate::operation::operation_deadline!();
        match adapter
            .inner
            .get_clipboard_content(ClipboardFormat::Text, deadline)
        {
            Ok(content) => {
                let text = match content {
                    Some(ClipboardContent::Text(text)) => text,
                    _ => String::new(),
                };
                let c = string_to_c(&text);
                if c.is_null() {
                    error::set_last_error(&agent_desktop_core::AdapterError::new(
                        agent_desktop_core::ErrorCode::Internal,
                        "clipboard text contains an interior NUL and cannot be represented as a C string",
                    ));
                    return AdResult::ErrInternal;
                }
                *out = c;
                AdResult::Ok
            }
            Err(e) => {
                error::set_last_error(&e);
                error::last_error_code()
            }
        }
    })
}

/// Writes UTF-8 `text` to the clipboard. Null or non-UTF-8 input returns
/// `AD_RESULT_ERR_INVALID_ARGS` with a diagnostic last-error.
///
/// # Safety
/// `adapter` must be a non-null pointer returned by `ad_adapter_create`.
/// `text` must be a non-null, NUL-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_set_clipboard(
    adapter: *const AdAdapter,
    text: *const c_char,
) -> AdResult {
    trap_panic(|| {
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        let text = match required_adapter_string(text, "text") {
            Ok(text) => text,
            Err(error) => {
                error::set_last_error(&error);
                return AdResult::ErrInvalidArgs;
            }
        };
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
        match adapter
            .inner
            .set_clipboard_content(&ClipboardContent::Text(text), &lease)
        {
            Ok(_) => AdResult::Ok,
            Err(e) => {
                error::set_last_error(&e);
                error::last_error_code()
            }
        }
    })
}

/// Clears the clipboard.
///
/// # Safety
/// `adapter` must be a non-null pointer returned by `ad_adapter_create`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_clear_clipboard(adapter: *const AdAdapter) -> AdResult {
    trap_panic(|| {
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
        match adapter.inner.clear_clipboard(&lease) {
            Ok(_) => AdResult::Ok,
            Err(e) => {
                error::set_last_error(&e);
                error::last_error_code()
            }
        }
    })
}

/// Frees a C string previously returned by `ad_get_clipboard` or any
/// other FFI call documented as allocating a C string for the caller.
/// Null-tolerant. Unknown pointers and repeated frees are ignored.
///
/// # Safety
/// `s` may be null or a pointer previously handed out by this crate.
/// After a successful free the pointer is invalid and must not be used.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_free_string(s: *mut c_char) {
    trap_panic_void(|| unsafe { free_c_string(s) })
}
