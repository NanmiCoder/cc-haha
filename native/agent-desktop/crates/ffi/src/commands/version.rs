use crate::commands::app_error_to_adapter;
use crate::commands::envelope_out::write_command_envelope;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::pointer_guard::guard_non_null;
use std::ffi::c_char;
use std::ptr;

/// Returns the `agent-desktop` version envelope as an owned JSON C string.
///
/// The returned string has the same `{version, ok, command, data}` shape
/// as `agent-desktop version` on the CLI. Free it with `ad_free_string`.
///
/// On success `*out` points to the envelope JSON.
/// On error `*out` is null and the last-error slot is populated.
///
/// # Safety
/// `out` must be a non-null writable `*mut *mut c_char`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_version(out: *mut *mut c_char) -> AdResult {
    trap_panic(|| unsafe {
        guard_non_null!(out, c"out is null");
        *out = ptr::null_mut();
        let context = match agent_desktop_core::context::CommandContext::new(None, None, false) {
            Ok(ctx) => ctx,
            Err(app_err) => {
                let ae = app_error_to_adapter(app_err);
                set_last_error(&ae);
                return crate::error::last_error_code();
            }
        };
        let scope = crate::commands::command_scope!(context, "version");
        let result = agent_desktop_core::commands::version::execute();
        crate::commands::complete_scope!(scope, &result);
        write_command_envelope("version", result, out)
    })
}
