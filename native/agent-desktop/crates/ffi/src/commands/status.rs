use crate::commands::app_error_to_adapter;
use crate::commands::envelope_out::write_command_envelope;
use crate::error::{self, AdResult};
use crate::ffi_try::trap_panic;
use crate::pointer_guard::guard_non_null;
use agent_desktop_core::AppError;
use agent_desktop_core::commands::status::execute_with_report_with_context;
use std::ffi::c_char;
use std::ptr;

/// Returns the adapter's current health and permission state as a JSON
/// envelope matching the `agent-desktop status` CLI output.
///
/// `ad_status` does not query the accessibility tree; it reads the
/// permission report and ref-store metadata only. Like other adapter
/// entrypoints, it may be called from any host thread. On success `*out` is a
/// NUL-terminated, heap-allocated JSON string freed with `ad_free_string`.
///
/// On a command-level failure `*out` is set to a heap-allocated JSON string
/// with `"ok":false` and an `"error"` payload. The caller must still release
/// it with `ad_free_string(*out)`. The last-error slot is also set.
///
/// On an argument or infrastructure failure (null adapter, null out, context
/// error) `*out` is zeroed and only the last-error slot is populated.
///
/// # Safety
///
/// `adapter` must be a non-null pointer returned by `ad_adapter_create`
/// that has not been destroyed. `out` must be a non-null writable
/// `*mut *mut c_char`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_status(
    adapter: *const crate::AdAdapter,
    out: *mut *mut c_char,
) -> AdResult {
    guard_non_null!(out, c"out is null");
    unsafe { *out = ptr::null_mut() };
    guard_non_null!(adapter, c"adapter is null");

    trap_panic(|| {
        let adapter = crate::adapter::acquire_adapter!(adapter);

        let ctx = match adapter.command_context() {
            Ok(c) => c,
            Err(app_err) => {
                let ae = app_error_to_adapter(app_err);
                error::set_last_error(&ae);
                return error::last_error_code();
            }
        };

        let deadline = crate::operation::operation_deadline!();
        let report = match adapter.inner.permission_report(deadline) {
            Ok(report) => report,
            Err(error) => {
                error::set_last_error(&error);
                return error::last_error_code();
            }
        };

        let scope = crate::commands::command_scope!(ctx, "status");

        let result: Result<serde_json::Value, AppError> =
            execute_with_report_with_context(&*adapter.inner, &report, &ctx);
        crate::commands::complete_scope!(scope, &result);

        unsafe { write_command_envelope("status", result, out) }
    })
}
