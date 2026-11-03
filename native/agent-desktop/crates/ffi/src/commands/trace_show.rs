use crate::AdAdapter;
use crate::commands::app_error_to_adapter;
use crate::commands::envelope_out::write_command_envelope;
use crate::convert::string::optional_adapter_string;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::pointer_guard::guard_non_null;
use std::ffi::c_char;
use std::ptr;

/// Returns the merged trace timeline for the adapter's active session as a
/// JSON envelope matching `agent-desktop trace show`.
///
/// `limit` controls tail semantics: `0` embeds all events; the default `500`
/// matches the CLI. Pass `-1` to use the CLI default explicitly.
///
/// `event_prefix` may be null; when set, only events whose name starts with the
/// prefix are returned before the tail limit is applied.
///
/// On success `*out` is a heap-allocated JSON envelope freed with
/// `ad_free_string`. On command-level failure `*out` still holds an error
/// envelope that must be freed.
///
/// # Safety
///
/// `adapter` must be a non-null pointer from `ad_adapter_create` or
/// `ad_adapter_create_with_session`. `out` must be non-null. `event_prefix`
/// may be null or a NUL-terminated UTF-8 string within `AD_MAX_STRING_BYTES + 1`
/// bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_trace_show(
    adapter: *const AdAdapter,
    limit: i32,
    event_prefix: *const c_char,
    out: *mut *mut c_char,
) -> AdResult {
    guard_non_null!(out, c"out is null");
    unsafe { *out = ptr::null_mut() };
    trap_panic(|| {
        guard_non_null!(adapter, c"adapter is null");

        let event = match optional_adapter_string(event_prefix, "event_prefix") {
            Ok(value) => value,
            Err(e) => {
                set_last_error(&e);
                return AdResult::ErrInvalidArgs;
            }
        };

        let effective_limit = if limit < 0 {
            agent_desktop_core::commands::trace::TRACE_SHOW_DEFAULT_LIMIT
        } else {
            limit as usize
        };

        let adapter_ref = crate::adapter::acquire_adapter!(adapter);
        let context = match adapter_ref.command_context() {
            Ok(ctx) => ctx,
            Err(e) => {
                let ae = app_error_to_adapter(e);
                set_last_error(&ae);
                return crate::error::last_error_code();
            }
        };

        let scope = crate::commands::command_scope!(context, "trace");
        let result = agent_desktop_core::commands::trace::execute(
            agent_desktop_core::commands::trace::TraceAction::Show {
                limit: effective_limit,
                event,
            },
            &context,
        );
        crate::commands::complete_scope!(scope, &result);

        unsafe { write_command_envelope("trace", result, out) }
    })
}
