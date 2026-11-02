mod common;

use common::{
    AdResult, CStr, ad_execute_by_ref, ad_execute_by_ref_timeout, ad_free_string,
    ad_last_error_code, ad_last_error_message, default_action, with_adapter,
};

#[test]
fn execute_by_ref_null_out_returns_invalid_args() {
    with_adapter(|adapter| unsafe {
        let ref_id = std::ffi::CString::new("@s8f3k2p9:e1").unwrap();
        let action = default_action();
        let rc = ad_execute_by_ref(adapter, ref_id.as_ptr(), &action, 0, std::ptr::null_mut());
        assert_eq!(
            rc,
            AdResult::ErrInvalidArgs,
            "null out is rejected by the outer guard before any thread or adapter check"
        );
    });
}

#[test]
fn execute_by_ref_null_adapter_rejected() {
    unsafe {
        let ref_id = std::ffi::CString::new("@s8f3k2p9:e1").unwrap();
        let action = default_action();
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_execute_by_ref(std::ptr::null(), ref_id.as_ptr(), &action, 0, &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.is_null(), "out must stay null on failure");
    }
}

#[test]
fn execute_by_ref_null_ref_id_returns_invalid_args() {
    with_adapter(|adapter| unsafe {
        let action = default_action();
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_execute_by_ref(adapter, std::ptr::null(), &action, 0, &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.is_null(), "out must stay null on null ref_id");
    });
}

#[test]
fn execute_by_ref_bare_ref_error_names_the_qualified_form() {
    with_adapter(|adapter| unsafe {
        let ref_id = std::ffi::CString::new("@e1").unwrap();
        let action = default_action();
        let mut out = std::ptr::null_mut();
        let result = ad_execute_by_ref(adapter, ref_id.as_ptr(), &action, 0, &mut out);
        assert_eq!(result, AdResult::ErrInvalidArgs);
        let message = CStr::from_ptr(ad_last_error_message()).to_string_lossy();
        assert!(message.contains("@<snapshot_id>:e<N>"), "{message}");
    });
}

#[test]
fn execute_by_ref_invalid_utf8_ref_id_returns_invalid_args() {
    with_adapter(|adapter| unsafe {
        let bad: [u8; 3] = [0xC3, 0xFF, 0x00];
        let action = default_action();
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_execute_by_ref(
            adapter,
            bad.as_ptr() as *const std::os::raw::c_char,
            &action,
            0,
            &mut out,
        );
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.is_null(), "out must stay null on invalid UTF-8 ref_id");
    });
}

#[test]
fn execute_by_ref_null_action_rejected() {
    with_adapter(|adapter| unsafe {
        let ref_id = std::ffi::CString::new("@s8f3k2p9:e1").unwrap();
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_execute_by_ref(adapter, ref_id.as_ptr(), std::ptr::null(), 0, &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.is_null(), "out must stay null on null action");
    });
}

#[test]
fn execute_by_ref_invalid_ref_format_returns_invalid_args() {
    with_adapter(|adapter| unsafe {
        let bad_ref = std::ffi::CString::new("@e0").unwrap();
        let action = default_action();
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_execute_by_ref(adapter, bad_ref.as_ptr(), &action, 0, &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.is_null(), "out must stay null on bad ref format");
    });
}

#[test]
fn execute_by_ref_returns_error_envelope_when_no_refmap_exists() {
    with_adapter(|adapter| unsafe {
        let ref_id = std::ffi::CString::new("@s8f3k2p9:e1").unwrap();
        let action = default_action();
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_execute_by_ref(adapter, ref_id.as_ptr(), &action, 0, &mut out);
        assert_ne!(rc, AdResult::Ok, "a ref with no refmap must not resolve");
        assert!(!out.is_null(), "command failure must return an envelope");
        let s = CStr::from_ptr(out).to_string_lossy().into_owned();
        ad_free_string(out);
        let val: serde_json::Value = serde_json::from_str(&s).expect("envelope must be JSON");
        assert_eq!(val["ok"].as_bool(), Some(false), "got: {s}");
        assert_eq!(val["command"].as_str(), Some("execute_by_ref"), "got: {s}");
        assert!(val["version"].is_string(), "got: {s}");
        assert!(val["error"]["code"].is_string(), "got: {s}");
        assert_eq!(ad_last_error_code(), rc, "errno invariant");
    });
}

#[test]
fn execute_by_ref_out_of_range_policy_returns_invalid_args() {
    with_adapter(|adapter| unsafe {
        let ref_id = std::ffi::CString::new("@s8f3k2p9:e1").unwrap();
        let action = default_action();
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_execute_by_ref(adapter, ref_id.as_ptr(), &action, 99, &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.is_null(), "out must stay null on invalid policy");
        assert_eq!(
            ad_last_error_code(),
            AdResult::ErrInvalidArgs,
            "last-error code must reflect the invalid-args rejection"
        );
    });
}

#[test]
fn execute_by_ref_timeout_rejects_values_below_default_sentinel_at_the_boundary() {
    with_adapter(|adapter| unsafe {
        let ref_id = std::ffi::CString::new("@s8f3k2p9:e1").unwrap();
        let action = default_action();
        let mut out = std::ptr::null_mut();

        let rc = ad_execute_by_ref_timeout(adapter, ref_id.as_ptr(), &action, 0, -2, &mut out);

        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.is_null());
        let message = CStr::from_ptr(ad_last_error_message()).to_string_lossy();
        assert!(message.contains("-1"));
        assert!(message.contains("0"));
    });
}

#[test]
fn execute_by_ref_timeout_accepts_default_and_single_shot_sentinels_before_ref_validation() {
    with_adapter(|adapter| unsafe {
        let invalid_ref = std::ffi::CString::new("@e0").unwrap();
        let action = default_action();
        for timeout_ms in [-1, 0] {
            let mut out = std::ptr::null_mut();
            let rc = ad_execute_by_ref_timeout(
                adapter,
                invalid_ref.as_ptr(),
                &action,
                0,
                timeout_ms,
                &mut out,
            );

            assert_eq!(rc, AdResult::ErrInvalidArgs);
            assert!(out.is_null());
            let message = CStr::from_ptr(ad_last_error_message()).to_string_lossy();
            assert!(message.contains("ref"));
            assert!(!message.contains("timeout_ms must"));
        }
    });
}
