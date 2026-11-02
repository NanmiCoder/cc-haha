use super::*;
use crate::system::window::window_identity::live_window_owner;
use agent_desktop_core::{Deadline, DeliveryDisposition, InteractionLease, ProcessId, WindowState};

#[cfg(target_os = "windows")]
fn lease() -> InteractionLease {
    InteractionLease::guarded(Deadline::after(10_000).unwrap(), ()).expect("lease")
}

#[cfg(target_os = "windows")]
fn destroyed_window(process_instance: Option<&str>) -> WindowInfo {
    WindowInfo {
        id: "w-1".into(),
        title: "gone".into(),
        app: "none.exe".into(),
        pid: ProcessId::from(1u32),
        process_instance: process_instance.map(str::to_string),
        bounds: None,
        state: WindowState::default(),
    }
}

#[cfg(target_os = "windows")]
fn staged_pair() -> (
    crate::tree::fixture::LocalFixture,
    crate::tree::fixture::LocalFixture,
    WindowInfo,
) {
    crate::tree::fixture::ensure_test_apartment();
    let (left_a, top_a) = crate::tree::fixture::fixture_window::on_screen_origin();
    let (left_b, top_b) = crate::tree::fixture::fixture_window::on_screen_origin();
    let target =
        crate::tree::fixture::LocalFixture::create_at(left_a, top_a).expect("target fixture");
    let stealer =
        crate::tree::fixture::LocalFixture::create_at(left_b, top_b).expect("stealer fixture");
    let info = window_info_for(target.handle());
    (target, stealer, info)
}

#[cfg(target_os = "windows")]
fn window_info_for(handle: isize) -> WindowInfo {
    crate::system::fixture::live_identity::window_info_for_current_process(handle)
}

#[cfg(target_os = "windows")]
fn raise_handle(handle: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    unsafe {
        let _ = SetForegroundWindow(handle as _);
    }
}

#[cfg(target_os = "windows")]
fn is_iconic(handle: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsIconic;
    unsafe { IsIconic(handle as _) != 0 }
}

/// Confirms success by the same two OS facts `is_owned_foreground` claims to
/// have established, read directly rather than by calling that predicate
/// again on the evidence it already consulted - re-asking the production
/// check the same question would only prove it agrees with itself.
#[cfg(target_os = "windows")]
fn assert_owned_success(info: &WindowInfo) {
    let handle = parse_handle(&info.id);
    assert!(
        is_foreground_window(handle),
        "success must leave the handle as the OS-reported foreground window"
    );
    assert_eq!(
        live_window_owner(handle),
        Some(info.pid),
        "success must leave the foreground window owned by the expected pid"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn visible_background_window_is_raised_without_restore() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (target, stealer, info) = staged_pair();
    raise_handle(stealer.handle());
    assert!(!is_iconic(target.handle()), "target must start visible");
    restore_probe::reset();
    let result = focus_window(&info, &lease());
    assert_eq!(
        restore_probe::count(),
        0,
        "visible-but-background must raise without SW_RESTORE"
    );
    match result {
        Ok(()) => assert_owned_success(&info),
        Err(error) => assert_eq!(error.code, ErrorCode::ActionFailed),
    }
    let _ = target;
}

#[cfg(target_os = "windows")]
#[test]
fn iconic_window_is_restored_then_raised() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (target, stealer, info) = staged_pair();
    target.minimize();
    assert!(is_iconic(target.handle()), "target must be iconic");
    raise_handle(stealer.handle());
    restore_probe::reset();
    let result = focus_window(&info, &lease());
    assert_eq!(restore_probe::count(), 1, "iconic must restore then raise");
    assert!(!is_iconic(target.handle()), "iconic must be restored");
    match result {
        Ok(()) => assert_owned_success(&info),
        Err(error) => assert_eq!(error.code, ErrorCode::ActionFailed),
    }
}

#[cfg(target_os = "windows")]
#[test]
fn restore_branch_fails_closed_on_recycled_ownership() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (target, _stealer, mut info) = staged_pair();
    target.minimize();
    info.process_instance = Some("windows-proc-v1:0:0".into());
    let handle = parse_handle(&info.id);
    let evidence = WindowIdentityEvidence::from_info(handle, &info).expect("evidence");
    let error = restore_if_iconic(handle, &evidence).expect_err("recycled restore");
    assert_eq!(error.code, ErrorCode::WindowNotFound);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert!(is_iconic(target.handle()), "restore must not have landed");
}

#[cfg(target_os = "windows")]
#[test]
fn raise_branch_fails_closed_on_recycled_ownership() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (_target, _stealer, mut info) = staged_pair();
    info.process_instance = Some("windows-proc-v1:0:0".into());
    let handle = parse_handle(&info.id);
    let evidence = WindowIdentityEvidence::from_info(handle, &info).expect("evidence");
    let error = bring_to_foreground(handle, &evidence).expect_err("recycled raise");
    assert_eq!(error.code, ErrorCode::WindowNotFound);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[cfg(target_os = "windows")]
#[test]
fn budget_retry_fails_closed_on_recycled_ownership() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (target, stealer, info) = staged_pair();
    raise_handle(stealer.handle());
    attempt_probe::reset();
    let error = never_foreground::with(|| {
        force_unowned_from_attempt::with(1, || focus_window(&info, &lease()).expect_err("recycle"))
    });
    assert_eq!(error.code, ErrorCode::WindowNotFound);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert!(
        attempt_probe::count() >= 1,
        "budget-retry branch must have entered a raise attempt"
    );
    let _ = target;
}

#[cfg(target_os = "windows")]
#[test]
fn strictly_higher_integrity_budget_exhaustion_is_perm_denied_never_action_failed() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (target, stealer, info) = staged_pair();
    raise_handle(stealer.handle());
    let error = never_foreground::with(|| {
        force_strictly_higher::with(|| focus_window(&info, &lease()).expect_err("denied"))
    });
    assert_eq!(error.code, ErrorCode::PermDenied);
    assert!(
        error.message.contains("window activation"),
        "production path must use the activation-worded denial, got {}",
        error.message
    );
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    let _ = target;
}

#[cfg(target_os = "windows")]
#[test]
fn focus_steal_budget_is_finite_and_fails_closed_not_delivered() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (target, stealer, info) = staged_pair();
    raise_handle(stealer.handle());
    attempt_probe::reset();
    let error = never_foreground::with(|| focus_window(&info, &lease()).expect_err("budget"));
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("physical_delivery_started")),
        Some(&serde_json::Value::Bool(false))
    );
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(
        attempt_probe::count(),
        FOCUS_STEAL_BUDGET,
        "budget must be exactly the finite A21-6 bound"
    );
    let _ = target;
}

#[cfg(target_os = "windows")]
#[test]
fn focus_window_reports_ok_only_when_the_expected_process_owns_the_foreground() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (target, stealer, info) = staged_pair();
    raise_handle(stealer.handle());
    match focus_window(&info, &lease()) {
        Ok(()) => assert_owned_success(&info),
        Err(error) => {
            assert_eq!(error.code, ErrorCode::ActionFailed);
            assert_eq!(
                error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("physical_delivery_started")),
                Some(&serde_json::Value::Bool(false))
            );
        }
    }
    let _ = target;
}

#[cfg(target_os = "windows")]
#[test]
fn a_recycled_generation_is_refused_even_when_the_owning_pid_matches() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (target, _stealer, expected) = staged_pair();
    let handle = parse_handle(&expected.id);
    let genuine = WindowIdentityEvidence::from_info(handle, &expected).expect("stored evidence");
    assert!(
        genuine.owns_handle_now().expect("owner read"),
        "the live fixture window must satisfy its own stored evidence"
    );
    let mut impostor_info = expected.clone();
    impostor_info.process_instance = Some("windows-proc-v1:0:0".into());
    let impostor =
        WindowIdentityEvidence::from_info(handle, &impostor_info).expect("stored evidence");
    assert!(
        !impostor.owns_handle_now().expect("owner read"),
        "a stale generation token must be refused even though the owning pid still matches"
    );
    assert!(
        !is_owned_foreground(handle, &impostor),
        "the success predicate must refuse a matching pid on a stale generation"
    );
    let _ = target;
}

#[cfg(target_os = "windows")]
#[test]
fn focus_window_refuses_a_destroyed_handle_before_any_window_write() {
    let win = destroyed_window(Some("windows-proc-v1:0:0"));
    let err = focus_window(&win, &lease()).unwrap_err();
    assert_eq!(err.code, ErrorCode::WindowNotFound);
}

#[cfg(target_os = "windows")]
#[test]
fn focus_window_refuses_an_expired_lease_before_any_window_write() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (_target, _stealer, expected) = staged_pair();
    let expired = InteractionLease::guarded(Deadline::after(1).unwrap(), ()).expect("lease");
    std::thread::sleep(std::time::Duration::from_millis(5));
    let err = focus_window(&expected, &expired).unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout);
}

#[cfg(target_os = "windows")]
#[test]
fn focus_window_requires_a_process_instance_token() {
    let win = destroyed_window(None);
    let err = focus_window(&win, &lease()).unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleRef);
}

/// Every headed command reaches `focus_window`, and identity verification
/// reads the live title before any raise, so a window whose thread never
/// dispatches would block the command inside the first native call that reaches its message queue. The
/// liveness ping must refuse it first.
#[cfg(target_os = "windows")]
#[test]
fn a_window_that_never_pumps_is_refused_before_activation_blocks() {
    let stalled = crate::tree::fixture::StalledFixture::create().expect("stalled");
    let info = window_info_for(stalled.handle());

    let error = focus_window(&info, &lease())
        .expect_err("a non-pumping target must be refused, not activated");

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("physical_delivery_started")),
        Some(&serde_json::Value::Bool(false)),
        "nothing was delivered, so headed input never started"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn foreground_call_returns_within_budget_when_target_hangs_after_probe() {
    let fixture = crate::tree::fixture::fixture_hung_after_probe::HungAfterProbeFixture::create()
        .expect("hostile fixture");
    let info = window_info_for(fixture.handle());
    fixture
        .hang_after_probe(2)
        .expect("second probe arms the hang");
    let started = std::time::Instant::now();

    let result = focus_window(&info, &lease());

    assert!(
        fixture.did_hang(),
        "target must hang after answering the probe"
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert!(
        !matches!(result, Err(ref error) if error.code == ErrorCode::AppUnresponsive),
        "the target answered the final probe, so foreground activation was attempted"
    );
}
