mod common;

use common::{
    AdResult, CStr, ad_adapter_create, ad_adapter_create_with_session, ad_adapter_destroy,
    ad_free_string, ad_last_error_code, ad_last_error_message, ad_status, with_isolated_home,
};

#[test]
fn adapter_creation_accepts_sessionless_null_and_valid_session_forms() {
    with_isolated_home(|| unsafe {
        let sessionless = ad_adapter_create();
        assert!(!sessionless.is_null());
        assert_eq!(status_session_id(sessionless), None);
        ad_adapter_destroy(sessionless);

        let null_session = ad_adapter_create_with_session(std::ptr::null());
        assert!(!null_session.is_null());
        assert_eq!(status_session_id(null_session), None);
        ad_adapter_destroy(null_session);

        let session = std::ffi::CString::new("agent-a").unwrap();
        let ptr = ad_adapter_create_with_session(session.as_ptr());
        assert!(
            !ptr.is_null(),
            "ad_adapter_create_with_session must not return null"
        );
        assert_eq!(status_session_id(ptr).as_deref(), Some("agent-a"));
        ad_adapter_destroy(ptr);
    });
}

unsafe fn status_session_id(adapter: *const common::AdAdapter) -> Option<String> {
    let mut out = std::ptr::null_mut();
    assert_eq!(unsafe { ad_status(adapter, &mut out) }, AdResult::Ok);
    assert!(!out.is_null());
    let envelope: serde_json::Value = serde_json::from_str(
        unsafe { CStr::from_ptr(out) }
            .to_str()
            .expect("status envelope must be UTF-8"),
    )
    .expect("status envelope must be JSON");
    unsafe { ad_free_string(out) };
    envelope["data"]["session_id"].as_str().map(str::to_owned)
}

#[test]
fn invalid_utf8_session_returns_null_and_sets_invalid_args() {
    unsafe {
        let bad: [u8; 3] = [0xC3, 0xFF, 0x00];
        let ptr = ad_adapter_create_with_session(bad.as_ptr() as *const std::os::raw::c_char);
        assert!(ptr.is_null(), "invalid UTF-8 session must return null");
        assert_eq!(
            ad_last_error_code(),
            AdResult::ErrInvalidArgs,
            "invalid UTF-8 must set ErrInvalidArgs"
        );
        let msg = ad_last_error_message();
        assert!(
            !msg.is_null(),
            "error message must be set on invalid UTF-8 session"
        );
    }
}

#[test]
fn empty_session_returns_null_and_sets_invalid_args() {
    unsafe {
        let empty = std::ffi::CString::new("").unwrap();
        let ptr = ad_adapter_create_with_session(empty.as_ptr());
        assert!(ptr.is_null(), "empty session id must return null");
        assert_eq!(
            ad_last_error_code(),
            AdResult::ErrInvalidArgs,
            "empty session id must set ErrInvalidArgs"
        );
        let msg = ad_last_error_message();
        assert!(!msg.is_null(), "error message must be set on empty session");
        let _ = CStr::from_ptr(msg).to_string_lossy();
    }
}
