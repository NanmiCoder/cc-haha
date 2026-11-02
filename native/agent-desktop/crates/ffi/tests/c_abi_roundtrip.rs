/// Integration tests for the observe→act loop at the C boundary.
///
/// # Test structure
///
/// - `stale_ref_returns_ok_false_error_envelope` — always runs in CI.
///   Sets a temp HOME (empty refmap), calls `ad_execute_by_ref`, and asserts
///   that the returned envelope has `ok:false` with both `error.code` (string)
///   and `error.message` (string), and that `command` equals `"execute_by_ref"`.
/// - `snapshot_execute_by_ref_live_roundtrip` — marked `#[ignore]`.
///   The full observe→act loop (real `ad_snapshot` → `@e` ref →
///   `ad_execute_by_ref` against a live app) requires Accessibility permission,
///   a stable target app, and an interactive macOS runner. CI proof is tracked
///   by the external-consumer smoke harness.
///   To run the roundtrip manually:
///   ```text
///   cargo test -p agent-desktop-ffi --tests c_abi_roundtrip \
///       snapshot_execute_by_ref_live_roundtrip -- --ignored
///   ```
///   AX accessibility permission must be granted and a target app must be open.
mod common;

use common::{
    AdResult, CStr, ad_execute_by_ref, ad_free_string, ad_snapshot, default_action, with_adapter,
};

/// Verifies the error-envelope contract at the C boundary when no refmap exists.
///
/// Sets a temp HOME so the refmap store is empty. Calls `ad_execute_by_ref`
/// with a well-formed qualified ref. The envelope must have
/// `ok:false` and carry both `error.code` (string) and `error.message`
/// (string) — the latter guaranteed by the AGENTS.md error contract — proving
/// the unified error-envelope contract holds at the ABI boundary.  The exact
/// `error.code` value is not pinned: an empty refmap may
/// surface either `SNAPSHOT_NOT_FOUND` or `STALE_REF` depending on the load
/// path; pinning either would make this test flaky.
#[test]
fn stale_ref_returns_ok_false_error_envelope() {
    with_adapter(|adapter| unsafe {
        let ref_id = std::ffi::CString::new("@smissing:e1").unwrap();
        let action = default_action();
        let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();

        let rc = ad_execute_by_ref(adapter, ref_id.as_ptr(), &action, 0, &mut out);

        let rc_i32 = rc as i32;
        assert!(
            rc_i32 <= 0,
            "must return a valid AdResult (<=0), got {rc_i32}"
        );

        assert!(!out.is_null(), "command failure must return an envelope");

        let s = CStr::from_ptr(out).to_string_lossy();
        let val: serde_json::Value = serde_json::from_str(&s).expect("response must be valid JSON");

        assert_eq!(
            val["ok"].as_bool(),
            Some(false),
            "error envelope ok must be false; got: {s}"
        );
        assert!(
            val["error"].is_object(),
            "error envelope must carry an error object; got: {s}"
        );
        assert!(
            val["error"]["code"].is_string(),
            "error.code must be a string; got: {s}"
        );
        assert!(
            val["error"]["message"].is_string(),
            "error.message must be a string; got: {s}"
        );
        assert!(
            val["version"].is_string(),
            "envelope version must be present; got: {s}"
        );
        assert_eq!(
            val["command"].as_str(),
            Some("execute_by_ref"),
            "command must be 'execute_by_ref'; got: {s}"
        );

        ad_free_string(out);
    });
}

/// Live snapshot→ref→execute_by_ref roundtrip at the C boundary.
///
/// This test is `#[ignore]` by design and must remain so in headless CI.
///
/// **Why ignored**: the test needs Accessibility permission, a live interactive
/// app, and exclusive control over mutable UI state. Those conditions are not
/// available on generic headless CI.
///
/// **Deferred CI proof**: the full-loop proof — real `ad_snapshot` producing
/// `@<snapshot_id>:e<N>` refs consumed by `ad_execute_by_ref` against a live app at the C
/// boundary — is deferred to an external-consumer smoke harness (Python
/// ctypes) that runs in the macOS E2E environment.
///
/// **Manual execution** (requires AX permission + a running target app):
/// ```text
/// cargo test -p agent-desktop-ffi --tests c_abi_roundtrip \
///     snapshot_execute_by_ref_live_roundtrip -- --ignored
/// ```
/// Do not un-ignore this test on generic CI.
#[test]
#[ignore = "requires AX permission, a live app, and exclusive interactive UI control"]
fn snapshot_execute_by_ref_live_roundtrip() {
    with_adapter(|adapter| unsafe {
        let mut snap_out: *mut std::os::raw::c_char = std::ptr::null_mut();
        let rc = ad_snapshot(adapter, std::ptr::null(), 0, 6, true, false, &mut snap_out);

        assert_eq!(rc, AdResult::Ok, "snapshot must succeed");
        assert!(
            !snap_out.is_null(),
            "snapshot out must be non-null on success"
        );

        let snap_str = CStr::from_ptr(snap_out).to_string_lossy();
        let snap_val: serde_json::Value =
            serde_json::from_str(&snap_str).expect("snapshot must be valid JSON");

        assert_eq!(
            snap_val["ok"].as_bool(),
            Some(true),
            "snapshot envelope ok must be true"
        );

        let ref_id = find_first_ref_in_tree(&snap_val)
            .expect("snapshot must contain at least one @<snapshot_id>:e<N> ref in the tree");

        ad_free_string(snap_out);

        let ref_cstr = std::ffi::CString::new(ref_id.as_str()).unwrap();
        let action = default_action();
        let mut exec_out: *mut std::os::raw::c_char = std::ptr::null_mut();

        let exec_rc = ad_execute_by_ref(adapter, ref_cstr.as_ptr(), &action, 0, &mut exec_out);

        assert!(
            !exec_out.is_null(),
            "execute_by_ref must produce an envelope (ok or error), got rc={exec_rc:?}"
        );

        let exec_str = CStr::from_ptr(exec_out).to_string_lossy();
        let exec_val: serde_json::Value =
            serde_json::from_str(&exec_str).expect("execute_by_ref response must be valid JSON");

        assert!(
            exec_val["version"].is_string(),
            "response must carry envelope version; got: {exec_str}"
        );
        assert!(
            exec_val["ok"].is_boolean(),
            "response must carry ok field; got: {exec_str}"
        );
        assert_eq!(
            exec_val["command"].as_str(),
            Some("execute_by_ref"),
            "command must be execute_by_ref; got: {exec_str}"
        );

        ad_free_string(exec_out);
    });
}

fn find_first_ref_in_tree(snap: &serde_json::Value) -> Option<String> {
    let mut searched = 0usize;
    common::find_ref_in_tree(snap, &mut searched, &|value| {
        let s = value.get("ref")?.as_str()?;
        (s.starts_with("@s") && s.contains(":e")).then(|| s.to_owned())
    })
}
