use crate::error::{AdResult, set_last_error_static};
use std::ffi::CStr;
use std::panic::{AssertUnwindSafe, catch_unwind};

static PANIC_MESSAGE: &CStr = c"rust panic in FFI boundary";

/// Runs `body` under a `catch_unwind` boundary. On panic, stashes a
/// `'static` last-error message and returns `AD_RESULT_ERR_INTERNAL`.
/// The panic payload is intentionally discarded: allocating inside a
/// panic handler risks double-panic, and the CLI/SDK caller only needs
/// to know "a Rust panic escaped the FFI surface" — the full diagnostic
/// lives in the host crash/trace logs via `tracing`.
///
/// The wrapped body must return an `AdResult`. For the (few) FFI
/// functions that return pointers (`ad_adapter_create`,
/// `ad_last_error_*`), use `trap_panic_ptr` instead.
pub(crate) fn trap_panic<F>(body: F) -> AdResult
where
    F: FnOnce() -> AdResult,
{
    match catch_unwind(AssertUnwindSafe(|| {
        crate::log_callback::with_dispatch(body)
    })) {
        Ok(result) => result,
        Err(_) => {
            set_last_error_static(AdResult::ErrInternal, PANIC_MESSAGE);
            AdResult::ErrInternal
        }
    }
}

/// Pointer-returning variant for `*mut T`: on panic, sets a `'static`
/// last-error and returns null. Used by `ad_adapter_create`.
pub(crate) fn trap_panic_ptr<T, F>(body: F) -> *mut T
where
    F: FnOnce() -> *mut T,
{
    match catch_unwind(AssertUnwindSafe(|| {
        crate::log_callback::with_dispatch(body)
    })) {
        Ok(ptr) => ptr,
        Err(_) => {
            set_last_error_static(AdResult::ErrInternal, PANIC_MESSAGE);
            std::ptr::null_mut()
        }
    }
}

/// Pointer-returning variant for `*const T`: on panic, sets a `'static`
/// last-error and returns null. Used by the `ad_last_error_*` readers.
pub(crate) fn trap_panic_const_ptr<T, F>(body: F) -> *const T
where
    F: FnOnce() -> *const T,
{
    match catch_unwind(AssertUnwindSafe(|| {
        crate::log_callback::with_dispatch(body)
    })) {
        Ok(ptr) => ptr,
        Err(_) => {
            set_last_error_static(AdResult::ErrInternal, PANIC_MESSAGE);
            std::ptr::null()
        }
    }
}

/// Void-return variant: on panic, sets a `'static` last-error and
/// swallows. Used by `ad_*_destroy`, `ad_free_*` — functions where the
/// C contract has no channel to signal failure. The caller can still
/// inspect `ad_last_error_*` if they care.
pub(crate) fn trap_panic_void<F>(body: F)
where
    F: FnOnce(),
{
    if catch_unwind(AssertUnwindSafe(|| {
        crate::log_callback::with_dispatch(body)
    }))
    .is_err()
    {
        set_last_error_static(AdResult::ErrInternal, PANIC_MESSAGE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_happy_path_passes_through() {
        let r = trap_panic(|| AdResult::Ok);
        assert_eq!(r, AdResult::Ok);
    }

    #[test]
    fn test_error_return_passes_through() {
        let r = trap_panic(|| AdResult::ErrInvalidArgs);
        assert_eq!(r, AdResult::ErrInvalidArgs);
    }

    #[test]
    fn test_panic_is_caught_and_returns_internal() {
        let first = trap_panic(|| -> AdResult { panic!("first") });
        assert_eq!(first, AdResult::ErrInternal);
        let second = trap_panic(|| -> AdResult { panic!("second") });
        assert_eq!(second, AdResult::ErrInternal);
    }

    #[test]
    fn test_panic_sets_static_last_error() {
        crate::error::clear_last_error();
        let _ = trap_panic(|| -> AdResult { panic!("synthetic panic") });
        assert_eq!(crate::error::last_error_code(), AdResult::ErrInternal);
    }

    #[test]
    fn test_pointer_panic_returns_null() {
        let p: *mut u8 = trap_panic_ptr(|| -> *mut u8 { panic!("boom") });
        assert!(p.is_null());
    }

    #[test]
    fn test_void_panic_is_swallowed() {
        trap_panic_void(|| panic!("boom"));
    }

    #[test]
    fn panic_handler_survives_reentrant_last_error_borrow() {
        let result = crate::error::with_last_error_mutably_borrowed(|| {
            trap_panic(|| -> AdResult { panic!("reentrant") })
        });
        assert_eq!(result, AdResult::ErrInternal);
    }
}
