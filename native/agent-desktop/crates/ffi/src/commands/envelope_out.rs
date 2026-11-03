use crate::commands::app_error_to_adapter;
use crate::convert::string::string_to_c;
use crate::error::{AdResult, set_last_error};
use agent_desktop_core::response::output::{ErrorPayload, Response};
use agent_desktop_core::{AdapterError, AppError, ErrorCode};
use serde_json::Value;
use std::ffi::c_char;

/// Serialises a command result into a JSON envelope and writes the heap-allocated
/// C string into `*out`.
///
/// **Ok path** (`result` is `Ok(data)`): builds `Response::ok(command, data)`,
/// serialises it, writes the pointer into `*out`, and returns `AdResult::Ok`.
/// The last-error slot is not touched — preserving any prior error across
/// successful calls (errno invariant).
///
/// **Err path** (`result` is `Err(app_err)`): builds `Response::err(command,
/// payload)` with the full error details, serialises it into `*out` (so
/// JSON-first consumers can inspect the error envelope), sets last-error, and
/// returns the matching negative `AdResult` code via `last_error_code()`.
/// The returned code is always identical to the code stored in last-error
/// (errno invariant).
///
/// **Serialisation/NUL failure** (interior NUL or `serde_json` error): sets
/// last-error to `ErrInternal`, leaves `*out` null, and returns `ErrInternal`.
///
/// # Contract
///
/// This helper covers only **command-level** results — i.e. after all argument
/// guards have passed and the command has actually executed. Pointer-guard
/// rejections (null `adapter`, null `out`, invalid-UTF-8 args) must keep
/// returning early with `*out` null; they must never call this helper.
///
/// The caller is responsible for zeroing `*out` before entering the command
/// body. `ad_free_string` must be called on any non-null `*out` after use,
/// regardless of whether the envelope carries `"ok":true` or `"ok":false`.
///
/// # Safety
///
/// `out` must be a non-null writable `*mut *mut c_char`. The caller guarantees
/// this via the `guard_non_null!(out, …)` check that precedes every command
/// body — this function does not re-validate it.
pub(crate) unsafe fn write_command_envelope(
    command: &str,
    result: Result<Value, AppError>,
    out: *mut *mut c_char,
) -> AdResult {
    let (envelope, had_error) = match result {
        Ok(data) => (Response::ok(command, data), false),
        Err(app_err) => {
            let payload = ErrorPayload::from_app_error(&app_err);
            let ae = app_error_to_adapter(app_err);
            set_last_error(&ae);
            (Response::err(command, payload), true)
        }
    };

    let json = match serde_json::to_string(&envelope) {
        Ok(s) => s,
        Err(e) => {
            let ae = AdapterError::new(
                ErrorCode::Internal,
                format!("failed to serialize {command} envelope: {e}"),
            );
            set_last_error(&ae);
            return AdResult::ErrInternal;
        }
    };

    let c_ptr = string_to_c(&json);
    if c_ptr.is_null() {
        let ae = AdapterError::new(
            ErrorCode::Internal,
            format!("{command} JSON contains interior NUL"),
        );
        set_last_error(&ae);
        return AdResult::ErrInternal;
    }

    unsafe { *out = c_ptr };

    if had_error {
        crate::error::last_error_code()
    } else {
        AdResult::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::string::free_c_string;
    use crate::error::{clear_last_error, last_error_code};
    use agent_desktop_core::AdapterError;
    use std::ffi::CStr;

    unsafe fn read_and_free(out: *mut c_char) -> String {
        let s = unsafe { CStr::from_ptr(out) }
            .to_string_lossy()
            .into_owned();
        unsafe { free_c_string(out) };
        s
    }

    #[test]
    fn err_path_writes_envelope_and_sets_errno() {
        clear_last_error();
        let mut out: *mut c_char = std::ptr::null_mut();
        let err = AppError::stale_ref("@e99");
        let rc = unsafe { write_command_envelope("wait", Err(err), &mut out) };

        assert_eq!(
            rc,
            AdResult::ErrStaleRef,
            "returned code must be ErrStaleRef"
        );
        assert_eq!(
            last_error_code(),
            AdResult::ErrStaleRef,
            "errno must equal returned code"
        );
        assert!(
            !out.is_null(),
            "*out must be non-null on command-level error"
        );

        let json = unsafe { read_and_free(out) };
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["command"], "wait");
        assert_eq!(parsed["error"]["code"], "STALE_REF");
    }

    #[test]
    fn ok_path_writes_envelope_and_preserves_prior_errno() {
        let prior = AdapterError::new(ErrorCode::Timeout, "prior error");
        set_last_error(&prior);

        let mut out: *mut c_char = std::ptr::null_mut();
        let rc = unsafe {
            write_command_envelope("status", Ok(serde_json::json!({"running": true})), &mut out)
        };

        assert_eq!(rc, AdResult::Ok, "returned code must be Ok on success");
        assert_eq!(
            last_error_code(),
            AdResult::ErrTimeout,
            "success must not clear prior last-error"
        );
        assert!(!out.is_null(), "*out must be non-null on success");

        let json = unsafe { read_and_free(out) };
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["command"], "status");
    }
}
