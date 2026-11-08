mod common;

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn exact_resolve_refuses_cross_frame_geometry_before_native_resolution() {
    with_adapter(|adapter| unsafe {
        for name in [std::ptr::null(), c"target".as_ptr()] {
            for has_bounds in [true, false] {
                let mut exact = default_exact_ref_entry();
                exact.process_instance = c"1:100".as_ptr();
                exact.entry.process.pid = 1;
                exact.entry.identity.role = c"button".as_ptr();
                exact.entry.identity.name = name;
                exact.entry.geometry.bounds = common::AdRect {
                    x: 110.0,
                    y: 24.0,
                    width: 80.0,
                    height: 30.0,
                };
                exact.entry.geometry.has_bounds = has_bounds;
                exact.entry.geometry.bounds_hash = 7;
                exact.entry.geometry.has_bounds_hash = !has_bounds;
                exact.entry.geometry.bounds_space = agent_desktop_ffi::AD_BOUNDS_SPACE_WINDOW;
                let mut out = AdNativeHandle {
                    ptr: std::ptr::dangling(),
                };
                assert_eq!(
                    ad_resolve_element_exact(adapter, &exact, &mut out),
                    AdResult::ErrInvalidArgs
                );
                assert!(out.ptr.is_null());
                let message = CStr::from_ptr(ad_last_error_message()).to_string_lossy();
                assert!(message.contains("screen-relative bounds"), "{message}");
            }
        }
    });
}

use common::{
    AdExactWindowInfo, AdExactWindowList, AdNativeHandle, AdResult, CStr, ad_last_error_message,
    ad_launch_app_exact, ad_list_windows_exact, ad_resolve_element_exact, c_char,
    default_exact_ref_entry, with_adapter,
};

#[test]
fn invalid_utf8_filter_rejected_not_silently_widened() {
    with_adapter(|adapter| unsafe {
        let bad: [u8; 2] = [0xC3, 0x00];
        let mut list: *mut AdExactWindowList = std::ptr::null_mut();
        let rc = ad_list_windows_exact(adapter, bad.as_ptr() as *const c_char, false, &mut list);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(list.is_null());
    });
}

#[test]
fn invalid_utf8_app_id_rejected() {
    with_adapter(|adapter| unsafe {
        let bad: [u8; 2] = [0xC3, 0];
        let mut out: AdExactWindowInfo = std::mem::zeroed();
        let rc = ad_launch_app_exact(adapter, bad.as_ptr() as *const c_char, 0, &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
    });
}

#[test]
fn exact_resolve_rejects_invalid_utf8_name_at_the_name_boundary() {
    with_adapter(|adapter| unsafe {
        let role = std::ffi::CString::new("button").unwrap();
        let process_instance = std::ffi::CString::new("generation-1").unwrap();
        let bad_name: [u8; 2] = [0xC3, 0x00];
        let mut exact = default_exact_ref_entry();
        exact.process_instance = process_instance.as_ptr();
        exact.entry.process.pid = 1;
        exact.entry.identity.role = role.as_ptr();
        exact.entry.identity.name = bad_name.as_ptr() as *const c_char;
        let mut out = AdNativeHandle {
            ptr: std::ptr::null(),
        };
        let rc = ad_resolve_element_exact(adapter, &exact, &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.ptr.is_null());
        let message = CStr::from_ptr(ad_last_error_message()).to_string_lossy();
        assert!(message.contains("identity.name"));
    });
}

#[test]
fn exact_resolve_rejects_invalid_utf8_description_at_the_description_boundary() {
    with_adapter(|adapter| unsafe {
        let role = std::ffi::CString::new("button").unwrap();
        let process_instance = std::ffi::CString::new("generation-1").unwrap();
        let bad_description: [u8; 2] = [0xC3, 0x00];
        let mut exact = default_exact_ref_entry();
        exact.process_instance = process_instance.as_ptr();
        exact.entry.process.pid = 1;
        exact.entry.identity.role = role.as_ptr();
        exact.entry.identity.description = bad_description.as_ptr() as *const c_char;
        let mut out = AdNativeHandle {
            ptr: std::ptr::null(),
        };
        let rc = ad_resolve_element_exact(adapter, &exact, &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.ptr.is_null());
        let message = CStr::from_ptr(ad_last_error_message()).to_string_lossy();
        assert!(message.contains("identity.description"));
    });
}
