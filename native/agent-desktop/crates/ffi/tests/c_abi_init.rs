mod common;

use common::{AdResult, CStr, ad_abi_version, ad_init, ad_last_error_code, ad_last_error_message};

#[test]
fn abi_version_matches_rust_constant() {
    unsafe {
        assert_eq!(
            ad_abi_version(),
            agent_desktop_ffi::AD_ABI_VERSION_MAJOR,
            "ad_abi_version() must equal AD_ABI_VERSION_MAJOR"
        );
    }
}

#[test]
fn ad_init_succeeds_with_current_major() {
    unsafe {
        assert_eq!(
            ad_init(agent_desktop_ffi::AD_ABI_VERSION_MAJOR),
            AdResult::Ok
        );
    }
}

#[test]
fn ad_init_rejects_previous_major() {
    unsafe {
        assert_eq!(ad_init(3), AdResult::ErrInvalidArgs);
    }
}

#[test]
fn ad_init_rejects_future_major_and_sets_last_error() {
    unsafe {
        let rc = ad_init(agent_desktop_ffi::AD_ABI_VERSION_MAJOR + 1);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        let msg = ad_last_error_message();
        assert!(
            !msg.is_null(),
            "last-error message must be non-null after mismatch"
        );
        let _ = CStr::from_ptr(msg).to_string_lossy();
        assert_eq!(ad_last_error_code(), AdResult::ErrInvalidArgs);
    }
}

#[test]
fn ad_init_rejects_zero_major_and_sets_last_error() {
    unsafe {
        let rc = ad_init(0);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        let msg = ad_last_error_message();
        assert!(
            !msg.is_null(),
            "last-error message must be non-null after zero-major mismatch"
        );
        let _ = CStr::from_ptr(msg).to_string_lossy();
        assert_eq!(ad_last_error_code(), AdResult::ErrInvalidArgs);
    }
}
