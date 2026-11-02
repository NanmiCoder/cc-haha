use crate::AdAdapter;
use crate::actions::result::action_result_to_c;
use crate::convert::string::required_adapter_string;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::types::{AdActionResult, AdNotificationActionRequest, AdPolicyKind};

/// Triggers the named action on the notification at `index`. Typical
/// action names are those reported in `AdNotificationInfo.actions`
/// (e.g. `"Reply"`, `"Open"`).
///
/// ## Identity / reorder safety
///
/// Notification Center reindexes entries on every listing — a new
/// notification arriving (or another one being dismissed) shifts which
/// notification sits at any given `index`. Calling this function with
/// an index obtained from a prior `ad_list_notifications` can therefore
/// press the action button on a different notification than the host
/// intended.
///
/// `request.identity` pins the target to an observed fingerprint. At least one
/// identity field is required; a mismatch fails closed with
/// `AD_RESULT_ERR_NOTIFICATION_NOT_FOUND`.
///
/// # Safety
/// `adapter` and `request` must be valid. `request.action_name` must be a
/// non-null UTF-8 C string. Identity fields must each be null or a
/// NUL-terminated UTF-8 C string. Invalid UTF-8 in either field
/// is rejected with `AD_RESULT_ERR_INVALID_ARGS` rather than silently
/// treated as "no fingerprint". `out` must be a valid writable
/// `*mut AdActionResult`; on error it is zero-initialized.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_notification_action(
    adapter: *const AdAdapter,
    request: *const AdNotificationActionRequest,
    out: *mut AdActionResult,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        *out = std::mem::zeroed();
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(request, c"request is null");
        let request = &*request;
        let index = match super::index::notification_index(request.index) {
            Ok(index) => index,
            Err(error) => {
                set_last_error(&error);
                return AdResult::ErrInvalidArgs;
            }
        };
        let action = match required_adapter_string(request.action_name, "action_name") {
            Ok(action) => action,
            Err(error) => {
                set_last_error(&error);
                return AdResult::ErrInvalidArgs;
            }
        };
        let identity = match super::identity::decode(request.identity.app, request.identity.title) {
            Ok(identity) => identity,
            Err(error) => {
                set_last_error(&error);
                return AdResult::ErrInvalidArgs;
            }
        };
        let policy = match AdPolicyKind::from_c(request.policy) {
            Some(policy) => policy.to_interaction_policy(),
            None => {
                set_last_error(&agent_desktop_core::AdapterError::new(
                    agent_desktop_core::ErrorCode::InvalidArgs,
                    "Invalid notification action policy",
                ));
                return AdResult::ErrInvalidArgs;
            }
        };
        if !policy.allow_focus_steal {
            set_last_error(&agent_desktop_core::AdapterError::policy_denied_for_policy(
                "Notification actions open and focus the operating system notification surface",
                policy,
            ));
            return crate::error::last_error_code();
        }
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
        let request = agent_desktop_core::NotificationActionRequest {
            index,
            identity: &identity,
            action_name: &action,
            policy,
        };
        match adapter.inner.notification_action(request, &lease) {
            Ok(result) => {
                *out = action_result_to_c(&result);
                AdResult::Ok
            }
            Err(e) => {
                set_last_error(&e);
                crate::error::last_error_code()
            }
        }
    })
}
