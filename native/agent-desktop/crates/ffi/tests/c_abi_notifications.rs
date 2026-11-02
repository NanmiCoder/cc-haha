mod common;

use common::{
    AdActionResult, AdNotificationActionRequest, AdNotificationIdentity, AdPolicyKind, AdResult,
    ad_last_error_code, ad_notification_action, with_adapter,
};
use std::ffi::CString;

#[test]
fn notification_action_rejects_null_request_before_platform_work() {
    with_adapter(|adapter| unsafe {
        let mut out = std::mem::zeroed::<AdActionResult>();
        let result = ad_notification_action(adapter, std::ptr::null(), &mut out);
        assert_eq!(result, AdResult::ErrInvalidArgs);
        assert_eq!(ad_last_error_code(), result);
    });
}

#[test]
fn notification_action_headless_policy_fails_closed() {
    with_adapter(|adapter| unsafe {
        let app = CString::new("Slack").unwrap();
        let action = CString::new("Reply").unwrap();
        let request = AdNotificationActionRequest {
            index: 1,
            policy: AdPolicyKind::Headless as i32,
            action_name: action.as_ptr(),
            identity: AdNotificationIdentity {
                app: app.as_ptr(),
                title: std::ptr::null(),
            },
        };
        let mut out = std::mem::zeroed::<AdActionResult>();
        let result = ad_notification_action(adapter, &request, &mut out);
        assert_eq!(result, AdResult::ErrPolicyDenied);
        assert_eq!(ad_last_error_code(), result);
        assert!(out.action.is_null());
    });
}
