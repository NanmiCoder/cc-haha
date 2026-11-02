use crate::AdAdapter;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use std::os::raw::c_char;

/// Closes the application identified by `id` (bundle id on macOS,
/// executable path on other platforms). `force = true` skips the
/// graceful-shutdown path, terminates matching app processes, and escalates
/// survivors when the platform supports it. Session-critical processes
/// (for example loginwindow and Dock on macOS, csrss.exe and winlogon.exe
/// on Windows) are refused with `AD_RESULT_ERR_INVALID_ARGS` — the protected-process
/// guard is enforced inside the adapter, so FFI and CLI behave
/// identically.
///
/// # Safety
/// `adapter` must be non-null. `id` must be a non-null UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_close_app(
    adapter: *const AdAdapter,
    id: *const c_char,
    force: bool,
) -> AdResult {
    trap_panic(|| {
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        let id_str = match super::decode_app_id(id) {
            Ok(id) => id,
            Err(err) => {
                set_last_error(&err);
                return crate::error::last_error_code();
            }
        };
        let adapter = crate::adapter::acquire_adapter!(adapter);
        match agent_desktop_core::commands::close_app::execute(
            agent_desktop_core::commands::close_app::CloseAppArgs { app: id_str, force },
            adapter.inner.as_ref(),
        ) {
            Ok(_) => AdResult::Ok,
            Err(e) => {
                set_last_error(&crate::commands::app_error_to_adapter(e));
                crate::error::last_error_code()
            }
        }
    })
}
