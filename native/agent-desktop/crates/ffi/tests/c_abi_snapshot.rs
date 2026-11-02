mod common;

use common::{AdResult, CStr, ad_free_string, ad_last_error_code, ad_snapshot, with_adapter};

#[test]
fn snapshot_null_out_returns_invalid_args() {
    with_adapter(|adapter| unsafe {
        let rc = ad_snapshot(
            adapter,
            std::ptr::null(),
            0,
            6,
            false,
            false,
            std::ptr::null_mut(),
        );
        assert_eq!(
            rc,
            AdResult::ErrInvalidArgs,
            "null out is rejected before adapter work"
        );
    });
}

#[test]
fn snapshot_null_adapter_rejected() {
    unsafe {
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_snapshot(
            std::ptr::null(),
            std::ptr::null(),
            0,
            6,
            false,
            false,
            &mut out,
        );
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.is_null(), "out must stay null on null-adapter failure");
    }
}

#[test]
fn snapshot_invalid_utf8_app_rejected() {
    with_adapter(|adapter| unsafe {
        let bad: [u8; 3] = [0xC3, 0xFF, 0x00];
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_snapshot(
            adapter,
            bad.as_ptr() as *const std::os::raw::c_char,
            0,
            6,
            false,
            false,
            &mut out,
        );
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(
            out.is_null(),
            "out must stay null on arg validation failure"
        );
    });
}

#[test]
fn snapshot_invalid_surface_rejected() {
    with_adapter(|adapter| unsafe {
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_snapshot(adapter, std::ptr::null(), 99, 6, false, false, &mut out);
        assert_eq!(rc, AdResult::ErrInvalidArgs);
        assert!(out.is_null(), "out must stay null on invalid surface");
    });
}

#[test]
fn snapshot_out_contains_envelope_fields_on_any_response() {
    with_adapter(|adapter| unsafe {
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_snapshot(adapter, std::ptr::null(), 0, 6, false, false, &mut out);

        assert!(
            !out.is_null(),
            "command-level result must write an envelope"
        );
        let s = CStr::from_ptr(out).to_string_lossy().into_owned();
        ad_free_string(out);
        let val: serde_json::Value = serde_json::from_str(&s).expect("envelope must be JSON");

        assert_eq!(
            val["version"].as_str(),
            Some(agent_desktop_core::response::output::ENVELOPE_VERSION),
            "envelope version must match ENVELOPE_VERSION, got: {s}"
        );
        assert_eq!(
            val["command"].as_str(),
            Some("snapshot"),
            "command must be exactly 'snapshot', got: {s}"
        );
        match val["ok"].as_bool() {
            Some(true) => assert_eq!(rc, AdResult::Ok, "ok:true envelope must return Ok"),
            Some(false) => {
                assert_ne!(rc, AdResult::Ok, "ok:false envelope must return an error");
                assert!(
                    val["error"]["code"].as_str().is_some_and(|c| !c.is_empty()),
                    "error.code must be a non-empty string, got: {s}"
                );
                assert_eq!(ad_last_error_code(), rc, "errno invariant");
            }
            None => panic!("envelope 'ok' must be a bool, got: {s}"),
        }
    });
}
