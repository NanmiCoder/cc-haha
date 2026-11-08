mod common;

use common::{
    AdOptionalU64, AdOptionalUsize, AdResult, AdWaitArgs, AdWaitMode, AdWaitPredicate, AdWaitScope,
    AdWaitSurfaceModes, CStr, ad_free_string, ad_last_error_code, ad_wait, with_adapter,
};

fn wait_args(ms: Option<u64>, element: *const std::os::raw::c_char, timeout_ms: u64) -> AdWaitArgs {
    AdWaitArgs {
        mode: AdWaitMode {
            pause: AdOptionalU64 {
                value: ms.unwrap_or_default(),
                present: ms.is_some(),
            },
            element,
            window: std::ptr::null(),
            text: std::ptr::null(),
            surfaces: AdWaitSurfaceModes {
                menu: false,
                menu_closed: false,
                notification: false,
            },
        },
        predicate: AdWaitPredicate {
            predicate: std::ptr::null(),
            value: std::ptr::null(),
            action: std::ptr::null(),
            count: AdOptionalUsize {
                value: 0,
                present: false,
            },
        },
        scope: AdWaitScope {
            timeout_ms,
            app: std::ptr::null(),
        },
    }
}

#[test]
fn ad_wait_null_args_rejected() {
    with_adapter(|adapter| unsafe {
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_wait(adapter, std::ptr::null(), &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.is_null(), "out must stay null on null-args rejection");
        assert_eq!(
            ad_last_error_code(),
            rc,
            "last-error code must match returned AdResult (errno invariant)"
        );
    });
}

#[test]
fn ad_wait_null_out_rejected() {
    with_adapter(|adapter| unsafe {
        let args = wait_args(Some(1), std::ptr::null(), 500);
        let rc = ad_wait(adapter, &args, std::ptr::null_mut());
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert_eq!(
            ad_last_error_code(),
            rc,
            "last-error code must match returned AdResult (errno invariant)"
        );
    });
}

#[test]
fn ad_wait_ms_mode_returns_ok_from_worker_thread() {
    with_adapter(|adapter| unsafe {
        let args = wait_args(Some(50), std::ptr::null(), 500);
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_wait(adapter, &args, &mut out);

        assert_eq!(rc, AdResult::Ok);
        assert!(!out.is_null(), "Ok result must set out");
        let json_cstr = CStr::from_ptr(out);
        let json: serde_json::Value = serde_json::from_str(json_cstr.to_str().unwrap()).unwrap();
        assert_eq!(json["ok"], serde_json::Value::Bool(true));
        assert_eq!(json["command"], "wait");
        ad_free_string(out);
    });
}

#[test]
fn ad_wait_command_error_writes_error_envelope_into_out() {
    with_adapter(|adapter| unsafe {
        let elem = std::ffi::CString::new("__nonexistent_element__").unwrap();
        let args = wait_args(None, elem.as_ptr(), 0);
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_wait(adapter, &args, &mut out);

        assert_ne!(
            rc,
            AdResult::Ok,
            "waiting for a nonexistent element with timeout 0 must fail"
        );
        assert!(
            !out.is_null(),
            "command-level error must write error envelope into *out, got rc={rc:?}"
        );
        let s = CStr::from_ptr(out).to_string_lossy();
        let val: serde_json::Value =
            serde_json::from_str(&s).expect("error envelope must be valid JSON");
        assert_eq!(
            val["ok"].as_bool(),
            Some(false),
            "error envelope ok must be false, got: {s}"
        );
        assert_eq!(
            val["command"].as_str(),
            Some("wait"),
            "command field must be 'wait', got: {s}"
        );
        assert!(
            val["error"].is_object(),
            "error envelope must carry an error object, got: {s}"
        );
        assert!(
            val["error"]["code"].as_str().is_some_and(|c| !c.is_empty()),
            "error.code must be a non-empty string, got: {s}"
        );
        assert_eq!(
            ad_last_error_code(),
            rc,
            "last-error code must match returned AdResult (errno invariant)"
        );
        ad_free_string(out);
    });
}
