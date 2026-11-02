//! Shared pointer-validation helper for FFI entrypoints.
//!
//! The FFI contract promises that malformed foreign input (null
//! pointers) turns into a structured `AD_RESULT_ERR_INVALID_ARGS`
//! error, not a segfault. `trap_panic` can only catch Rust panics — it
//! does not recover from raw-pointer UB. Every extern fn therefore
//! validates its inputs before the first dereference using
//! [`guard_non_null`].

/// Bail out of the enclosing `AdResult`-returning function with
/// `AD_RESULT_ERR_INVALID_ARGS` when `$ptr` is null. The `'static`
/// `$message` is surfaced via the errno-style last-error slot so C
/// consumers see which pointer was rejected.
macro_rules! guard_non_null {
    ($ptr:expr, $message:expr) => {
        if ($ptr).is_null() {
            $crate::error::set_last_error_static($crate::error::AdResult::ErrInvalidArgs, $message);
            return $crate::error::AdResult::ErrInvalidArgs;
        }
    };
}

pub(crate) use guard_non_null;

#[cfg(test)]
mod tests {
    use crate::error::AdResult;

    fn null_case() -> AdResult {
        let null_ptr: *const u8 = std::ptr::null();
        guard_non_null!(null_ptr, c"null_ptr");
        AdResult::Ok
    }

    fn nonnull_case() -> AdResult {
        let value: u8 = 0;
        let ptr: *const u8 = &value;
        guard_non_null!(ptr, c"ptr");
        AdResult::Ok
    }

    #[test]
    fn null_pointer_short_circuits_with_invalid_args() {
        assert!(matches!(null_case(), AdResult::ErrInvalidArgs));
        assert_eq!(crate::error::last_error_code(), AdResult::ErrInvalidArgs);
    }

    #[test]
    fn non_null_pointer_passes_through() {
        assert!(matches!(nonnull_case(), AdResult::Ok));
    }
}
