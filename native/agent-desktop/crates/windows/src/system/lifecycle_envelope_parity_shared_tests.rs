use super::*;
use agent_desktop_core::WindowOp;

/// Wire-shape assertion for a class-(a) condition - one both platforms can
/// reach for the same real-world event, per the taxonomy
/// `lifecycle_envelope_parity.rs` documents. This never reads or compares
/// against macOS source; each call site's own doc comment states what, if
/// anything, is independently verified against `crates/macos` for that
/// specific condition.
fn assert_class_a_envelope(error: &AdapterError, code: ErrorCode, expected: DeliverySemantics) {
    assert_code_wire(error, code);
    assert_disposition_wire(error, expected);
}

/// Targets a `HostedFixture` this test alone owns, never this process's own
/// pid: the graceful close arm broadcasts `WM_CLOSE` to every top-level
/// window the target pid owns, and the test runner's own pid also owns
/// other tests' in-process `LocalFixture` windows running in parallel, so
/// targeting it here would destroy them. A fixture host that swallows
/// `WM_CLOSE` never closes, so the deadline genuinely expires.
///
/// macOS pins the identical pair for the identical condition - a deadline
/// that expires waiting for exit after termination was already requested -
/// in `crates/macos/src/system/app/app_ops.rs`'s `wait_for_exit`.
#[test]
fn shared_timeout_after_close_delivery_pins_the_windows_envelope() {
    #[cfg(target_os = "windows")]
    {
        crate::tree::fixture::bootstrap();
        let fixture = crate::tree::fixture::HostedFixture::spawn_swallowing_wm_close()
            .expect("swallowing fixture");
        let pid = ProcessId::from(fixture.process_id());
        let token = crate::system::process_identity::token_for_pid(pid)
            .expect("token")
            .expect("live");
        let app = AppInfo {
            name: "fixture-host".into(),
            pid,
            bundle_id: None,
            process_instance: Some(token),
            presentation: None,
        };
        let error = close_app_impl(&app, false, Deadline::after(200).expect("deadline"))
            .expect_err("timeout");
        assert_class_a_envelope(
            &error,
            ErrorCode::Timeout,
            DeliverySemantics::delivered_unverified(),
        );
        assert_eq!(error_wire(&error)["disposition"]["retry"], "unsafe");
    }
}

/// `budget_exhausted(false)` is Windows' own focus-steal-retry-budget
/// exhaustion; macOS's activation path carries no equivalent budget to
/// exhaust, so no macOS call site pins this exact pair. The pair still
/// expresses a cross-platform rule rather than a Windows-only one:
/// `crates/macos/src/actions/chain/mod.rs::exhaustion_disposition` reports the
/// identical `ActionFailed`/not-delivered pair whenever its own chain, too,
/// has issued no successful step.
#[test]
fn shared_action_failed_before_delivery_pins_the_windows_envelope() {
    let error = budget_exhausted(false);
    assert_class_a_envelope(
        &error,
        ErrorCode::ActionFailed,
        DeliverySemantics::not_delivered(),
    );
    assert_eq!(error_wire(&error)["disposition"]["retry"], "safe");
}

/// `AdapterError::permission_denied()` is the core constructor Windows'
/// write-path classifier
/// (`crates/windows/src/actions/mutation.rs::classify_hresult`, on
/// `E_ACCESSDENIED`) and macOS's own AX-permission gates (for example
/// `crates/macos/src/actions/ax_mutation.rs`) both call for "the OS denied
/// this process accessibility access," so the pair cannot drift between
/// platforms without an edit to core. No lifecycle adapter function reaches
/// that condition on Windows today - close, launch, window-op, and focus
/// never probe whole-process UI Automation access - so this test drives the
/// real Windows call site that does, instead of a hand-written literal
/// standing in for it.
#[test]
fn shared_perm_denied_before_delivery_pins_the_windows_envelope() {
    use crate::actions::mutation::classify_mutation;
    use crate::system::runtime::hresult::E_ACCESSDENIED;
    use crate::tree::automation::UiaFailure;

    let error = classify_mutation(
        "SetValue",
        "ValuePattern.SetValue",
        &UiaFailure::Hresult(E_ACCESSDENIED),
    )
    .expect_err("access-denied write must classify as an error");
    assert_class_a_envelope(
        &error,
        ErrorCode::PermDenied,
        DeliverySemantics::not_delivered(),
    );
    assert_eq!(error_wire(&error)["disposition"]["retry"], "safe");
}

/// Windows raises `StaleRef` here because `window_op_impl` has no
/// process-instance token to verify before mutating the window, so the
/// write is refused before any native call. That code choice is not a
/// verified macOS match: macOS's own "no identity to verify" cases choose
/// different codes for the same missing-token shape -
/// `crates/macos/src/system/app/app_ops.rs::close_app_impl` reports
/// `InvalidArgs`, and
/// `crates/macos/src/system/window/window_resolve.rs::verify_window_record`
/// reports `WindowNotFound`. This test therefore pins only the Windows wire
/// shape.
#[test]
fn adapter_window_op_without_a_process_instance_keeps_the_stale_ref_envelope() {
    use agent_desktop_core::{InteractionLease, SystemOps};

    let win = WindowInfo {
        id: "w-1".into(),
        title: String::new(),
        app: "fixture".into(),
        pid: ProcessId::from(1u32),
        process_instance: None,
        bounds: None,
        state: WindowState::default(),
    };
    let deadline = Deadline::after(1_000).expect("deadline");
    let lease = InteractionLease::guarded(deadline, ()).expect("lease");

    let error = crate::adapter::WindowsAdapter::new()
        .window_op(&win, WindowOp::Minimize, &lease)
        .expect_err("stale");

    assert_class_a_envelope(
        &error,
        ErrorCode::StaleRef,
        DeliverySemantics::not_delivered(),
    );
}
