use crate::AdAdapter;
use crate::actions::conversion::action_from_c;
use crate::actions::result::action_result_to_c;
use crate::commands::app_error_to_adapter;
use crate::error::{self, AdResult};
use crate::ffi_try::trap_panic;
use crate::types::{AdAction, AdActionResult, AdExactRefEntry, AdNativeHandle, AdPolicyKind};
use agent_desktop_core::{Action, ActionRequest};

/// Low-level native-handle action. Dispatches directly to the platform adapter
/// without strict ref re-identification or actionability preflight. This is a
/// raw escape hatch for callers that already hold a live native handle. Callers
/// wanting CLI-semantics parity (RefStore load → strict resolution → preflight
/// → dispatch) should use `ad_execute_by_ref` instead.
///
/// # Safety
///
/// `adapter` must be a non-null pointer returned by `ad_adapter_create`.
/// `handle` must be a non-null pointer to a valid `AdNativeHandle` produced by
/// the same live adapter. Free the handle before destroying that adapter.
/// `action` must be a non-null pointer to a valid `AdAction`.
/// `out` must be a non-null pointer to an `AdActionResult` to write the result into.
///
/// Handles come from exact resolvers and already carry process-generation
/// evidence, so this executes under the same policy as
/// `ad_execute_action_with_policy`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_execute_action(
    adapter: *const AdAdapter,
    handle: *const AdNativeHandle,
    action: *const AdAction,
    out: *mut AdActionResult,
) -> AdResult {
    unsafe {
        ad_execute_action_with_policy(adapter, handle, action, AdPolicyKind::Headless as i32, out)
    }
}

/// Low-level native-handle action with explicit interaction policy. Dispatches
/// directly to the platform adapter without strict ref re-identification or
/// actionability preflight. The `policy` discriminant is applied verbatim — no
/// base-policy elevation is performed. This is a raw escape hatch for callers
/// that already hold a live native handle. Callers wanting CLI-semantics parity
/// (RefStore load → strict resolution → preflight → dispatch with base-policy
/// join) should use `ad_execute_by_ref` instead.
///
/// # Safety
///
/// `adapter` must be a non-null pointer returned by `ad_adapter_create`.
/// `handle` must be a non-null pointer to a valid `AdNativeHandle` produced by
/// the same live adapter. Free the handle before destroying that adapter.
/// `action` must be a non-null pointer to a valid `AdAction`.
/// `out` must be a non-null pointer to an `AdActionResult` to write the result into.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_execute_action_with_policy(
    adapter: *const AdAdapter,
    handle: *const AdNativeHandle,
    action: *const AdAction,
    policy: i32,
    out: *mut AdActionResult,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        *out = std::mem::zeroed();
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(handle, c"handle is null");
        crate::pointer_guard::guard_non_null!(action, c"action is null");
        let handle_ref = &*handle;
        if handle_ref.ptr.is_null() {
            error::set_last_error(&agent_desktop_core::AdapterError::new(
                agent_desktop_core::ErrorCode::InvalidArgs,
                "handle.ptr is null — the handle has already been freed or was never resolved",
            ));
            return AdResult::ErrInvalidArgs;
        }
        let core_action = match decode_action(&*action) {
            Ok(action) => action,
            Err(result) => return result,
        };
        let policy = match decode_policy(policy) {
            Ok(policy) => policy,
            Err(result) => return result,
        };
        let adapter_id = adapter.addr();
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let (native_handle, process) =
            match crate::actions::native_handle::acquire_ffi_handle(adapter_id, handle_ref) {
                Ok(handle) => handle,
                Err(error) => {
                    error::set_last_error(&error);
                    return AdResult::ErrInvalidArgs;
                }
            };
        let request = action_request(policy, core_action).with_expected_process(process);
        let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
        if let Action::Drag(params) = &request.action
            && let Err(error) = params.validate(lease.deadline())
        {
            error::set_last_error(&error);
            return error::last_error_code();
        }
        match agent_desktop_core::execute_verified_action(
            adapter.inner.as_ref(),
            native_handle.as_ref(),
            request,
            &lease,
        ) {
            Ok(result) => {
                *out = action_result_to_c(&result);
                AdResult::Ok
            }
            Err(e) => {
                error::set_last_error(&e);
                error::last_error_code()
            }
        }
    })
}

/// Executes a struct-based ref action with exact process-generation and typed
/// native-id evidence.
///
/// # Safety
///
/// All pointers must be valid. `entry` must carry the current exact-entry
/// version and size. `out` is zeroed before any fallible operation.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_execute_ref_action_exact_with_policy(
    adapter: *const AdAdapter,
    entry: *const AdExactRefEntry,
    action: *const AdAction,
    policy: i32,
    out: *mut AdActionResult,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        *out = std::mem::zeroed();
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(entry, c"entry is null");
        crate::pointer_guard::guard_non_null!(action, c"action is null");
        let core_entry = match crate::actions::resolve::core_ref_entry_from_exact(&*entry) {
            Ok(entry) => entry,
            Err(error) => {
                error::set_last_error(&error);
                return error::last_error_code();
            }
        };
        execute_core_ref_action(adapter, core_entry, &*action, policy, out)
    })
}

unsafe fn execute_core_ref_action(
    adapter: *const AdAdapter,
    entry: agent_desktop_core::RefEntry,
    action: &AdAction,
    policy: i32,
    out: *mut AdActionResult,
) -> AdResult {
    let core_action = match decode_action(action) {
        Ok(action) => action,
        Err(result) => return result,
    };
    let policy = match decode_policy(policy) {
        Ok(policy) => policy,
        Err(result) => return result,
    };
    let adapter_ref = crate::adapter::acquire_adapter!(adapter);
    let request = action_request(policy, core_action);
    let context = match adapter_ref.command_context() {
        Ok(context) => context,
        Err(error) => {
            error::set_last_error(&app_error_to_adapter(error));
            return error::last_error_code();
        }
    };
    match agent_desktop_core::ref_action::execute_entry_with_context(
        adapter_ref.inner.as_ref(),
        &entry,
        request,
        &context,
    ) {
        Ok(result) => {
            unsafe { *out = action_result_to_c(&result) };
            AdResult::Ok
        }
        Err(error) => {
            error::set_last_error(&error);
            error::last_error_code()
        }
    }
}

fn decode_action(action: &AdAction) -> Result<Action, AdResult> {
    unsafe { action_from_c(action) }.map_err(|msg| {
        error::set_last_error(&agent_desktop_core::AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            msg,
        ));
        AdResult::ErrInvalidArgs
    })
}

fn decode_policy(policy: i32) -> Result<AdPolicyKind, AdResult> {
    AdPolicyKind::from_c(policy).ok_or_else(|| {
        error::set_last_error(&agent_desktop_core::AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "invalid policy kind discriminant",
        ));
        AdResult::ErrInvalidArgs
    })
}

fn action_request(policy: AdPolicyKind, action: Action) -> ActionRequest {
    match policy {
        AdPolicyKind::Headless => ActionRequest::headless(action),
        AdPolicyKind::FocusFallback => ActionRequest::focus_fallback(action),
        AdPolicyKind::Headed => ActionRequest::headed(action),
    }
    .with_timeout_ms(Some(crate::operation::DEFAULT_FFI_TIMEOUT_MS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::{Action, actions::interaction_policy::InteractionPolicy};

    #[test]
    fn ffi_policy_kind_maps_to_core_interaction_policy() {
        assert_eq!(
            action_request(AdPolicyKind::Headless, Action::Click).policy,
            InteractionPolicy::headless()
        );
        assert_eq!(
            action_request(AdPolicyKind::FocusFallback, Action::Click).policy,
            InteractionPolicy::focus_fallback()
        );
        assert_eq!(
            action_request(AdPolicyKind::Headed, Action::Click).policy,
            InteractionPolicy::headed()
        );
    }
}
