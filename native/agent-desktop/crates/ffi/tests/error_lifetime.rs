use agent_desktop_ffi::error::AdResult;
use std::ffi::CStr;

#[allow(improper_ctypes)]
unsafe extern "C" {
    fn ad_adapter_create() -> *mut agent_desktop_ffi::AdAdapter;
    fn ad_adapter_destroy(adapter: *mut agent_desktop_ffi::AdAdapter);
    fn ad_launch_app_exact(
        adapter: *const agent_desktop_ffi::AdAdapter,
        id: *const std::os::raw::c_char,
        timeout_ms: u64,
        out: *mut agent_desktop_ffi::AdExactWindowInfo,
    ) -> AdResult;
    fn ad_app_list_count(list: *const agent_desktop_ffi::AdAppList) -> u32;
    fn ad_exact_window_list_count(list: *const agent_desktop_ffi::AdExactWindowList) -> u32;
    fn ad_last_error_message() -> *const std::os::raw::c_char;
    fn ad_last_error_details() -> *const std::os::raw::c_char;
    fn ad_last_error_code() -> AdResult;
}

/// Any failure populates last-error and the pointer stays stable across later
/// successful calls on the same thread.
#[test]
fn last_error_pointer_survives_across_successful_calls() {
    unsafe {
        let adapter = ad_adapter_create();
        assert!(!adapter.is_null());

        let bad_id = std::ptr::null();
        let mut out_win: agent_desktop_ffi::AdExactWindowInfo = std::mem::zeroed();
        let rc = ad_launch_app_exact(adapter, bad_id, 0, &mut out_win);
        assert_eq!(rc, AdResult::ErrInvalidArgs);

        let first_msg_ptr = ad_last_error_message();
        let first_details_ptr = ad_last_error_details();
        assert!(!first_msg_ptr.is_null());
        assert!(first_details_ptr.is_null());
        let first_msg = CStr::from_ptr(first_msg_ptr).to_string_lossy().into_owned();

        for _ in 0..10 {
            let next = ad_adapter_create();
            assert!(!next.is_null());
            ad_adapter_destroy(next);
        }
        for _ in 0..5 {
            let _ = ad_app_list_count(std::ptr::null());
            let _ = ad_exact_window_list_count(std::ptr::null());
        }

        let later_msg_ptr = ad_last_error_message();
        assert_eq!(first_msg_ptr, later_msg_ptr);
        assert_eq!(first_details_ptr, ad_last_error_details());
        let later_msg = CStr::from_ptr(later_msg_ptr).to_string_lossy().into_owned();
        assert_eq!(first_msg, later_msg);
        assert_eq!(ad_last_error_code(), rc);

        ad_adapter_destroy(adapter);
    }
}
