/// Stub-adapter passthrough tests for Family-B command-backed entrypoints.
/// Gate with `--features stub-adapter`.
///
/// # Coverage
///
/// This file exercises:
/// - **Family-B command-backed entrypoints**: `ad_snapshot`, `ad_status`,
///   `ad_wait`, `ad_execute_by_ref`, `ad_version`
/// - **Adapter lifecycle**: `ad_adapter_create`, `ad_adapter_destroy`
/// - **Permissions**: `ad_check_permissions`
///
/// The ~35 Family-A entrypoints (`ad_find_exact`, `ad_execute_action`,
/// `ad_list_windows_exact`, `ad_screenshot`, clipboard, notifications, etc.) are
/// **not covered here**; broader Family-A passthrough is a documented
/// follow-up.
///
/// # Why the stub returns `not_supported`
///
/// The stub's `PlatformAdapter` impl delegates all methods to the trait
/// defaults, which uniformly return `AdapterError::not_supported(…)` →
/// `ErrorCode::PlatformNotSupported`. The JSON envelope therefore carries
/// `"ok":false` and `"error":{"code":"PLATFORM_NOT_SUPPORTED","suggestion":…}`.
///
/// # Exception — `ad_check_permissions`
///
/// The stub's `permission_report()` returns `PermissionState::Unknown` (the
/// trait default), not `Denied`. The FFI maps `Unknown` to
/// `ErrPlatformNotSupported (-8)`, not `ErrPermDenied (-1)`, because an
/// adapter that never probed permissions has not been denied anything;
/// `ErrPermDenied` is reserved for an explicit `Denied` state.
///
/// Commands gated by `#[cfg(feature = "stub-adapter")]` so they compile only
/// when the feature is active. The normal test build (`cargo test -p
/// agent-desktop-ffi --tests`) never compiles or runs this file.
#[cfg(feature = "stub-adapter")]
mod common;

#[cfg(feature = "stub-adapter")]
use common::{
    AdResult, AdWaitArgs, CStr, ad_adapter_create, ad_adapter_destroy, ad_check_permissions,
    ad_clear_clipboard, ad_execute_by_ref, ad_free_string, ad_get_clipboard, ad_last_error_code,
    ad_last_error_message, ad_list_apps, ad_set_clipboard, ad_snapshot, ad_status, ad_version,
    ad_wait, default_action, with_adapter,
};

/// A helper that parses the JSON envelope written to `*out` and asserts
/// `PLATFORM_NOT_SUPPORTED` shape.
#[cfg(feature = "stub-adapter")]
unsafe fn assert_platform_not_supported_envelope(out: *mut std::os::raw::c_char) {
    assert!(!out.is_null(), "command failure must produce an envelope");
    let json_str = unsafe { CStr::from_ptr(out) }
        .to_str()
        .expect("envelope must be valid UTF-8");
    let parsed: serde_json::Value =
        serde_json::from_str(json_str).expect("envelope must be valid JSON");
    assert_eq!(
        parsed["ok"].as_bool(),
        Some(false),
        "stub adapter must produce ok:false envelope — got: {json_str}"
    );
    assert_eq!(
        parsed["error"]["code"].as_str(),
        Some("PLATFORM_NOT_SUPPORTED"),
        "error.code must be PLATFORM_NOT_SUPPORTED — got: {json_str}"
    );
    let suggestion = parsed["error"]["suggestion"].as_str().unwrap_or_default();
    assert!(
        !suggestion.is_empty(),
        "error.suggestion must be non-empty — got: {json_str}"
    );
}

/// `ad_version` has no adapter dependency and must always succeed even on a
/// stub build.
#[cfg(feature = "stub-adapter")]
#[test]
fn stub_ad_version_always_succeeds() {
    unsafe {
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_version(&mut out);
        assert_eq!(
            rc,
            AdResult::Ok,
            "ad_version must succeed regardless of adapter (no adapter dependency)"
        );
        assert!(!out.is_null(), "out must be non-null on success");
        let json_str = CStr::from_ptr(out).to_str().expect("valid UTF-8");
        let parsed: serde_json::Value = serde_json::from_str(json_str).expect("valid JSON");
        assert_eq!(parsed["ok"].as_bool(), Some(true));
        assert!(parsed["data"]["version"].is_string());
        ad_free_string(out);
    }
}

/// `ad_check_permissions` reports `ErrPlatformNotSupported (-8)` on an adapter
/// that never probes permissions. Not having measured a permission is a
/// different fact from a user having denied one, and `ErrPermDenied (-1)` sends
/// callers looking for a grant that does not exist on that platform.
#[cfg(feature = "stub-adapter")]
#[test]
fn stub_ad_check_permissions_returns_err_platform_not_supported() {
    with_adapter(|adapter| unsafe {
        let rc = ad_check_permissions(adapter);
        assert_eq!(
            rc,
            AdResult::ErrPlatformNotSupported,
            "an adapter that does not probe permissions reports Unknown, which must \
             surface as ErrPlatformNotSupported (-8), never ErrPermDenied (-1)."
        );
        let msg = ad_last_error_message();
        assert!(
            !msg.is_null(),
            "last-error message must be set on ErrPlatformNotSupported"
        );
        assert_eq!(ad_last_error_code(), AdResult::ErrPlatformNotSupported);
    });
}

/// Under the stub adapter `ad_status` returns a valid JSON envelope with
/// `ok:true` because `execute_with_report_with_context`
/// reports the Denied permission state as a valid (non-error) status payload.
///
/// This test asserts the envelope is produced and is valid JSON — the specific
/// permission values are stub-specific but the shape must always match the CLI.
#[cfg(feature = "stub-adapter")]
#[test]
fn stub_ad_status_returns_valid_envelope() {
    with_adapter(|adapter| unsafe {
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_status(adapter, &mut out);
        assert!(
            !out.is_null(),
            "ad_status must always produce an envelope (ok or error) — rc={rc:?}"
        );
        let json_str = CStr::from_ptr(out)
            .to_str()
            .expect("envelope must be valid UTF-8");
        let parsed: serde_json::Value =
            serde_json::from_str(json_str).expect("envelope must be valid JSON");
        assert!(
            parsed["ok"].is_boolean(),
            "envelope must carry ok field — got: {json_str}"
        );
        assert_eq!(
            parsed["command"].as_str(),
            Some("status"),
            "command field must be 'status'"
        );
        let _ = rc;
        ad_free_string(out);
    });
}

/// The stub adapter must produce a `PLATFORM_NOT_SUPPORTED` error envelope.
#[cfg(feature = "stub-adapter")]
#[test]
fn stub_ad_snapshot_returns_platform_not_supported_envelope() {
    with_adapter(|adapter| unsafe {
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_snapshot(adapter, std::ptr::null(), 0, 6, false, false, &mut out);
        assert_eq!(rc, AdResult::ErrPlatformNotSupported);
        assert_platform_not_supported_envelope(out);
        ad_free_string(out);
    });
}

/// `ad_wait` is exercised in its adapter-free `ms` mode: it sleeps for `ms`
/// and returns an Ok envelope without touching the adapter, proving the
/// entrypoint is callable and structured under the stub without crashing.
/// ad_wait's adapter-dependent
/// element/predicate modes need a real refmap from a successful snapshot,
/// which the stub cannot produce, so PLATFORM_NOT_SUPPORTED parity for those
/// modes is covered by the real E2E harness rather than this stub gate.
#[cfg(feature = "stub-adapter")]
#[test]
fn stub_ad_wait_ms_mode_callable_under_stub() {
    with_adapter(|adapter| unsafe {
        let args = AdWaitArgs {
            mode: common::AdWaitMode {
                pause: common::AdOptionalU64 {
                    value: 1,
                    present: true,
                },
                element: std::ptr::null(),
                window: std::ptr::null(),
                text: std::ptr::null(),
                surfaces: common::AdWaitSurfaceModes {
                    menu: false,
                    menu_closed: false,
                    notification: false,
                },
            },
            predicate: common::AdWaitPredicate {
                predicate: std::ptr::null(),
                value: std::ptr::null(),
                action: std::ptr::null(),
                count: common::AdOptionalUsize {
                    value: 0,
                    present: false,
                },
            },
            scope: common::AdWaitScope {
                timeout_ms: 200,
                app: std::ptr::null(),
            },
        };
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_wait(adapter, &args, &mut out);
        assert_eq!(rc, AdResult::Ok);
        assert!(!out.is_null());
        ad_free_string(out);
    });
}

/// A qualified ref reaches the ref-store path without relying on ambient
/// snapshot state.
#[cfg(feature = "stub-adapter")]
#[test]
fn stub_ad_execute_by_ref_returns_structured_ref_error() {
    with_adapter(|adapter| unsafe {
        let ref_id = std::ffi::CString::new("@stub-snapshot:e1").unwrap();
        let action = default_action();
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_execute_by_ref(adapter, ref_id.as_ptr(), &action, 0, &mut out);
        match rc {
            AdResult::ErrPlatformNotSupported
            | AdResult::ErrSnapshotNotFound
            | AdResult::ErrStaleRef => {
                assert!(!out.is_null());
                let json_str = CStr::from_ptr(out)
                    .to_str()
                    .expect("envelope must be valid UTF-8");
                let parsed: serde_json::Value =
                    serde_json::from_str(json_str).expect("envelope must be valid JSON");
                assert_eq!(parsed["ok"].as_bool(), Some(false));
                assert!(!parsed["error"]["code"].as_str().unwrap_or("").is_empty());
                ad_free_string(out);
            }
            other => {
                panic!(
                    "stub ad_execute_by_ref must return ErrPlatformNotSupported, \
                     ErrSnapshotNotFound, or ErrStaleRef, got {other:?}"
                );
            }
        }
    });
}

/// Confirm that `ad_adapter_create` itself does not panic under the stub
/// feature and produces a non-null handle that can be destroyed cleanly.
#[cfg(feature = "stub-adapter")]
#[test]
fn stub_adapter_create_and_destroy_round_trip() {
    unsafe {
        let adapter = ad_adapter_create();
        assert!(
            !adapter.is_null(),
            "stub ad_adapter_create must not return null"
        );
        ad_adapter_destroy(adapter);
    }
}

/// AppKit-backed platform implementations remain callable from worker threads;
/// the macOS adapter supplies its own autorelease pools. The stub proves that
/// the FFI boundary reaches the adapter rather than rejecting the thread.
#[cfg(feature = "stub-adapter")]
#[test]
fn app_and_clipboard_families_reach_stub_from_worker_thread() {
    let results = std::thread::spawn(|| unsafe {
        let adapter = ad_adapter_create();
        assert!(!adapter.is_null());

        let mut apps = std::ptr::null_mut();
        let list_apps = ad_list_apps(adapter, &mut apps);
        assert!(apps.is_null());

        let mut clipboard = std::ptr::null_mut();
        let get_clipboard = ad_get_clipboard(adapter, &mut clipboard);
        assert!(clipboard.is_null());

        let text = std::ffi::CString::new("worker-thread").unwrap();
        let set_clipboard = ad_set_clipboard(adapter, text.as_ptr());
        let clear_clipboard = ad_clear_clipboard(adapter);

        ad_adapter_destroy(adapter);
        [list_apps, get_clipboard, set_clipboard, clear_clipboard]
    })
    .join()
    .unwrap();

    assert_eq!(results, [AdResult::ErrPlatformNotSupported; 4]);
}
