use crate::AdAdapter;
use crate::convert::string::decode_optional_filter;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use std::os::raw::c_char;

/// Dismisses a notification only when the current row matches an identity
/// observed in the same listing. At least one expected field is required.
///
/// # Safety
/// `adapter` must be valid. String pointers may be null and otherwise must be
/// NUL-terminated UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_dismiss_notification(
    adapter: *const AdAdapter,
    index: u32,
    app_filter: *const c_char,
    expected_app: *const c_char,
    expected_title: *const c_char,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        let index = match super::index::notification_index(index) {
            Ok(index) => index,
            Err(error) => {
                set_last_error(&error);
                return AdResult::ErrInvalidArgs;
            }
        };
        let filter = decode_optional_filter!(app_filter, "app_filter");
        let identity = match super::identity::decode(expected_app, expected_title) {
            Ok(identity) => identity,
            Err(error) => {
                set_last_error(&error);
                return AdResult::ErrInvalidArgs;
            }
        };
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
        let request = agent_desktop_core::DismissNotificationRequest {
            index,
            app_filter: filter.as_deref(),
            identity: &identity,
            policy: agent_desktop_core::actions::interaction_policy::InteractionPolicy::headless(),
        };
        match adapter.inner.dismiss_notification(request, &lease) {
            Ok(_) => AdResult::Ok,
            Err(error) => {
                set_last_error(&error);
                crate::error::last_error_code()
            }
        }
    })
}
