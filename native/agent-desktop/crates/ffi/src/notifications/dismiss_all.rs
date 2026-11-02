use crate::AdAdapter;
use crate::convert::notification::notification_info_to_c;
use crate::convert::string::decode_optional_filter;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::notifications::list::ad_notification_list_free;
use crate::types::{AdNotificationInfo, AdNotificationList};
use std::os::raw::c_char;
use std::ptr;

/// Dismisses every notification matching `app_filter` (null = all apps).
///
/// Returns two lists: `dismissed_out` carries the notifications that
/// were successfully dismissed; `failed_out` holds error strings for
/// notifications where the platform rejected the dismiss. Partial
/// failures do not set last-error — inspect `failed_out` for details.
///
/// `failed_out` uses the notification-list handle to stay ABI-consistent
/// with the other list-returning FFI calls; the entries carry the
/// original notification shape with `body` populated by the platform
/// error message.
///
/// # Safety
/// `adapter` must be valid. `app_filter` may be null. `dismissed_out`
/// and `failed_out` must both be valid writable `*mut *mut AdNotificationList`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_dismiss_all_notifications(
    adapter: *const AdAdapter,
    app_filter: *const c_char,
    dismissed_out: *mut *mut AdNotificationList,
    failed_out: *mut *mut AdNotificationList,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(dismissed_out, c"dismissed_out is null");
        crate::pointer_guard::guard_non_null!(failed_out, c"failed_out is null");
        *dismissed_out = ptr::null_mut();
        *failed_out = ptr::null_mut();
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        let filter = decode_optional_filter!(app_filter, "app_filter");
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let filter_ref = filter.as_deref();
        let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
        let request = agent_desktop_core::DismissAllNotificationsRequest {
            app_filter: filter_ref,
            policy: agent_desktop_core::actions::interaction_policy::InteractionPolicy::headless(),
        };
        match adapter.inner.dismiss_all_notifications(request, &lease) {
            Ok((dismissed, failed_messages)) => {
                if let Err(error) = crate::resource::validate_list_len(
                    dismissed.len().max(failed_messages.len()),
                    "Notification mutation result",
                ) {
                    set_last_error(&error);
                    return crate::error::last_error_code();
                }
                let dismissed_items: Vec<AdNotificationInfo> =
                    dismissed.iter().map(notification_info_to_c).collect();
                let dismissed_list = Box::new(AdNotificationList {
                    items: dismissed_items.into_boxed_slice(),
                });
                *dismissed_out = Box::into_raw(dismissed_list);

                let failed_items: Vec<AdNotificationInfo> = failed_messages
                    .into_iter()
                    .enumerate()
                    .map(|(i, msg)| {
                        let info = agent_desktop_core::NotificationInfo {
                            index: i,
                            app_name: String::new(),
                            title: String::from("dismiss failed"),
                            body: Some(msg),
                            actions: Vec::new(),
                        };
                        notification_info_to_c(&info)
                    })
                    .collect();
                let failed_list = Box::new(AdNotificationList {
                    items: failed_items.into_boxed_slice(),
                });
                *failed_out = Box::into_raw(failed_list);
                AdResult::Ok
            }
            Err(e) => {
                set_last_error(&e);
                crate::error::last_error_code()
            }
        }
    })
}

/// Convenience wrapper: free both lists returned by
/// `ad_dismiss_all_notifications`. Equivalent to calling
/// `ad_notification_list_free` on each; provided for symmetry.
///
/// # Safety
/// Both arguments must be null or pointers from
/// `ad_dismiss_all_notifications`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_dismiss_all_notifications_free(
    dismissed: *mut AdNotificationList,
    failed: *mut AdNotificationList,
) {
    unsafe {
        ad_notification_list_free(dismissed);
        ad_notification_list_free(failed);
    }
}
