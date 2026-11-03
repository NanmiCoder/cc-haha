use crate::AdAdapter;
use crate::actions::conversion::action_from_c;
use crate::commands::app_error_to_adapter;
use crate::commands::envelope_out::write_command_envelope;
use crate::commands::timeout::decode_ref_action_timeout;
use crate::convert::string::required_adapter_string;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::pointer_guard::guard_non_null;
use crate::types::{AdAction, AdPolicyKind};
use agent_desktop_core::refs::validate_ref_id;
use agent_desktop_core::{AdapterError, ErrorCode};
use std::ffi::c_char;
use std::ptr;

/// Same as `ad_execute_by_ref` but with an explicit pre-action auto-wait
/// budget in milliseconds. `timeout_ms == -1` uses the 5000ms default and
/// `timeout_ms == 0` disables auto-wait for a single-shot preflight.
///
/// # Safety
///
/// Same pointer and threading requirements as `ad_execute_by_ref`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_execute_by_ref_timeout(
    adapter: *const AdAdapter,
    ref_id: *const c_char,
    action: *const AdAction,
    policy: i32,
    timeout_ms: i64,
    out: *mut *mut c_char,
) -> AdResult {
    guard_non_null!(out, c"out is null");
    unsafe { *out = ptr::null_mut() };
    trap_panic(|| {
        guard_non_null!(adapter, c"adapter is null");
        guard_non_null!(action, c"action is null");
        let timeout_ms = match decode_ref_action_timeout(timeout_ms) {
            Ok(timeout_ms) => timeout_ms,
            Err(err) => {
                set_last_error(&err);
                return AdResult::ErrInvalidArgs;
            }
        };

        let ref_str = match required_adapter_string(ref_id, "ref_id") {
            Ok(s) => s,
            Err(e) => {
                set_last_error(&e);
                return AdResult::ErrInvalidArgs;
            }
        };

        if let Err(app_err) = validate_ref_id(&ref_str) {
            let ae = app_error_to_adapter(app_err);
            set_last_error(&ae);
            return crate::error::last_error_code();
        }

        let caller_policy = match AdPolicyKind::from_c(policy) {
            Some(p) => p,
            None => {
                set_last_error(&AdapterError::new(
                    ErrorCode::InvalidArgs,
                    "invalid policy kind discriminant",
                ));
                return AdResult::ErrInvalidArgs;
            }
        };

        let core_action = match unsafe { action_from_c(&*action) } {
            Ok(a) => a,
            Err(msg) => {
                set_last_error(&AdapterError::new(ErrorCode::InvalidArgs, msg));
                return AdResult::ErrInvalidArgs;
            }
        };

        let caller_ip = caller_policy.to_interaction_policy();

        let adapter_ref = crate::adapter::acquire_adapter!(adapter);
        let context = match adapter_ref.command_context() {
            Ok(ctx) => ctx,
            Err(e) => {
                let ae = app_error_to_adapter(e);
                set_last_error(&ae);
                return crate::error::last_error_code();
            }
        };

        let scope = crate::commands::mutating_command_scope!(context, "execute_by_ref");

        let result = agent_desktop_core::commands::execute_by_ref::execute_with_timeout(
            agent_desktop_core::commands::execute_by_ref::ExecuteByRefArgs {
                ref_id: &ref_str,
                action: core_action,
                caller_policy: caller_ip,
            },
            timeout_ms,
            adapter_ref.inner.as_ref(),
            &context,
        );
        crate::commands::complete_scope!(scope, &result);

        unsafe { write_command_envelope("execute_by_ref", result, out) }
    })
}
