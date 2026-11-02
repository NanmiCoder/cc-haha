mod common;

use common::{
    AdResult, CStr, ad_free_string, ad_last_error_code, ad_status, ad_version, with_adapter,
};

#[test]
fn ad_version_returns_ok_with_valid_json_envelope() {
    unsafe {
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_version(&mut out);
        assert_eq!(rc, AdResult::Ok, "ad_version must return OK");
        assert!(!out.is_null(), "out must be non-null on success");

        let json_str = CStr::from_ptr(out).to_string_lossy();
        let parsed: serde_json::Value =
            serde_json::from_str(&json_str).expect("output must be valid JSON");

        assert_eq!(
            parsed["ok"].as_bool(),
            Some(true),
            "envelope ok must be true"
        );
        assert_eq!(
            parsed["command"].as_str(),
            Some("version"),
            "envelope command must be 'version'"
        );
        assert!(
            parsed["data"]["version"].is_string(),
            "data.version must be a string"
        );
        assert!(
            parsed["data"]["target"].is_string(),
            "data.target must be a string"
        );
        assert!(parsed["data"]["os"].is_string(), "data.os must be a string");

        let envelope_version = parsed["version"]
            .as_str()
            .expect("version field must exist");
        assert_eq!(
            envelope_version,
            agent_desktop_core::response::output::ENVELOPE_VERSION,
            "envelope version must match ENVELOPE_VERSION constant"
        );

        ad_free_string(out);
    }
}

#[test]
fn ad_version_null_out_returns_invalid_args() {
    unsafe {
        let rc = ad_version(std::ptr::null_mut());
        assert_eq!(
            rc,
            AdResult::ErrInvalidArgs,
            "null out must return ErrInvalidArgs"
        );
    }
}

#[test]
fn ad_free_string_ignores_a_second_free() {
    unsafe {
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        assert_eq!(ad_version(&mut out), AdResult::Ok);
        assert!(!out.is_null());

        ad_free_string(out);
        ad_free_string(out);
    }
}

#[test]
fn ad_version_success_preserves_prior_last_error() {
    unsafe {
        let rc_fail = ad_version(std::ptr::null_mut());
        assert_eq!(rc_fail, AdResult::ErrInvalidArgs);
        let err_before = ad_last_error_code();
        assert_eq!(err_before, AdResult::ErrInvalidArgs);

        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc_ok = ad_version(&mut out);
        assert_eq!(rc_ok, AdResult::Ok);

        assert_eq!(
            ad_last_error_code(),
            AdResult::ErrInvalidArgs,
            "success must not clear the prior last-error"
        );

        ad_free_string(out);
    }
}

#[test]
fn status_null_adapter_returns_invalid_args() {
    unsafe {
        let mut out: *mut std::os::raw::c_char = 0xDEAD_BEEF as *mut std::os::raw::c_char;
        let rc = ad_status(std::ptr::null(), &mut out);
        assert_eq!(
            rc,
            AdResult::ErrInvalidArgs,
            "null adapter must return ErrInvalidArgs"
        );
        assert!(
            out.is_null(),
            "dirty out-param must be zeroed before early return on null adapter"
        );
    }
}

#[test]
fn status_null_out_returns_invalid_args() {
    with_adapter(|adapter| unsafe {
        let rc = ad_status(adapter, std::ptr::null_mut());
        assert_eq!(
            rc,
            AdResult::ErrInvalidArgs,
            "null out must return ErrInvalidArgs"
        );
    });
}

#[test]
fn status_returns_ok_envelope_with_required_fields() {
    with_adapter(|adapter| unsafe {
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_status(adapter, &mut out);
        assert_eq!(rc, AdResult::Ok, "ad_status must return Ok");
        assert!(!out.is_null(), "out must be non-null on success");

        let json_str = CStr::from_ptr(out)
            .to_str()
            .expect("status output must be valid UTF-8");
        let val: serde_json::Value =
            serde_json::from_str(json_str).expect("status output must be valid JSON");

        assert_eq!(
            val["version"].as_str(),
            Some(agent_desktop_core::response::output::ENVELOPE_VERSION),
            "envelope version must match ENVELOPE_VERSION constant"
        );
        assert_eq!(val["ok"].as_bool(), Some(true), "ok must be true");
        assert_eq!(
            val["command"].as_str(),
            Some("status"),
            "command must be \"status\""
        );

        let data = &val["data"];
        assert!(
            data["platform"].is_string(),
            "data.platform must be present"
        );
        assert!(data["version"].is_string(), "data.version must be present");
        assert!(
            data["permissions"].is_object(),
            "data.permissions must be present"
        );

        ad_free_string(out);
    });
}
