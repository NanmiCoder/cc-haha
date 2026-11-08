use crate::AdAdapter;
use crate::commands::app_error_to_adapter;
use crate::commands::envelope_out::write_command_envelope;
use crate::convert::string::optional_adapter_string;
use crate::error::{self, AdResult};
use crate::ffi_try::trap_panic;
use crate::pointer_guard::guard_non_null;
use crate::types::wait_args::AdWaitArgs;
use agent_desktop_core::AdapterError;
use agent_desktop_core::commands::wait::{WaitArgs, WaitModeArgs, WaitPredicateArgs};
use agent_desktop_core::commands::wait_surface::SurfaceWait;
use std::ffi::c_char;
use std::ptr;

/// Runs `wait` with the given args, blocking the calling thread until the
/// condition is met or `timeout_ms` elapses.
///
/// On success `*out` is set to a freshly allocated JSON string containing the
/// CLI-format wait envelope (`{version, ok, command, data}`). The caller must
/// release the string with `ad_free_string(*out)`.
///
/// On a command-level failure (e.g. `TIMEOUT`, `ELEMENT_NOT_FOUND`) `*out` is
/// set to a freshly allocated JSON string with `"ok":false` and an `"error"`
/// payload. The caller must still release it with `ad_free_string(*out)`. The
/// last-error slot is also set.
///
/// On an argument or infrastructure failure (null adapter, null args, null out,
/// invalid UTF-8 field) `*out` is zeroed, the last-error slot
/// is set, and a negative `AdResult` code is returned. No allocation is made.
///
/// # Safety
///
/// `adapter` must be a non-null pointer returned by `ad_adapter_create` that
/// has not been destroyed. `args` must be non-null and point to a valid
/// zero-initialized `AdWaitArgs`. `out` must be non-null and point to a
/// writable `*mut c_char`.
///
/// All `*const c_char` fields inside `AdWaitArgs` must be null or point to
/// readable, NUL-terminated memory within `AD_MAX_STRING_BYTES + 1` bytes.
///
/// `ad_wait` retains the adapter while blocked. Concurrent destruction revokes
/// the opaque adapter token for new calls without invalidating this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_wait(
    adapter: *const AdAdapter,
    args: *const AdWaitArgs,
    out: *mut *mut c_char,
) -> AdResult {
    guard_non_null!(out, c"out is null");
    unsafe { *out = ptr::null_mut() };
    guard_non_null!(args, c"args is null");

    trap_panic(|| {
        guard_non_null!(adapter, c"adapter is null");

        let ffi_args = unsafe { &*args };
        let mut wait_args = match wait_args_from_ffi(ffi_args) {
            Ok(args) => args,
            Err(err) => {
                error::set_last_error(&err);
                return error::last_error_code();
            }
        };
        let adapter_ref = crate::adapter::acquire_adapter!(adapter);

        let ctx = match adapter_ref.command_context() {
            Ok(c) => c,
            Err(app_err) => {
                let adapter_err = app_error_to_adapter(app_err);
                error::set_last_error(&adapter_err);
                return error::last_error_code();
            }
        };

        let scope = crate::commands::command_scope!(ctx, "wait");

        let result = SurfaceWait::from_flags(
            ffi_args.mode.surfaces.menu,
            ffi_args.mode.surfaces.menu_closed,
            ffi_args.mode.surfaces.notification,
        )
        .and_then(|surface| {
            wait_args.mode.surface = surface;
            agent_desktop_core::commands::wait::execute(wait_args, adapter_ref.inner.as_ref(), &ctx)
        });
        crate::commands::complete_scope!(scope, &result);

        unsafe { write_command_envelope("wait", result, out) }
    })
}

fn wait_args_from_ffi(args: &AdWaitArgs) -> Result<WaitArgs, AdapterError> {
    Ok(WaitArgs {
        mode: WaitModeArgs {
            ms: args.mode.pause.present.then_some(args.mode.pause.value),
            element: optional_adapter_string(args.mode.element, "mode.element")?,
            window: optional_adapter_string(args.mode.window, "mode.window")?,
            text: optional_adapter_string(args.mode.text, "mode.text")?,
            surface: None,
            event: None,
            window_id: None,
        },
        predicate: WaitPredicateArgs {
            predicate: optional_adapter_string(args.predicate.predicate, "predicate.kind")?,
            value: optional_adapter_string(args.predicate.value, "predicate.value")?,
            action: optional_adapter_string(args.predicate.action, "predicate.action")?,
            count: args
                .predicate
                .count
                .present
                .then_some(args.predicate.count.value),
        },
        timeout_ms: args.scope.timeout_ms,
        app: optional_adapter_string(args.scope.app, "scope.app")?,
    })
}
