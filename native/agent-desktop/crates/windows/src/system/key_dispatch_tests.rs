use super::*;
use agent_desktop_core::{
    Action, DeliveryDisposition, InteractionPolicy, KeyCombo, ProcessId, ProcessIdentity,
    WindowInfo, WindowState,
};

#[cfg(target_os = "windows")]
pub(super) use crate::system::fixture::test_time::deadline;

#[cfg(target_os = "windows")]
pub(super) fn combo_a() -> KeyCombo {
    KeyCombo {
        key: "a".into(),
        modifiers: vec![],
    }
}

#[cfg(target_os = "windows")]
fn identity_for_pid(pid: ProcessId) -> ProcessIdentity {
    let token = process_identity::token_for_pid(pid)
        .expect("token read")
        .expect("live token");
    ProcessIdentity::new(pid, token)
}

#[cfg(target_os = "windows")]
fn raise_handle(handle: isize) {
    let _ = crate::system::fixture::test_support::stage_foreground(handle);
}

#[cfg(target_os = "windows")]
pub(super) fn staged_hosted_target() -> (crate::tree::fixture::HostedFixture, ProcessIdentity) {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("hosted fixture");
    let pid = ProcessId::from(fixture.process_id());
    let identity = identity_for_pid(pid);
    (fixture, identity)
}

#[cfg(target_os = "windows")]
fn window_info_for_hosted(fixture: &crate::tree::fixture::HostedFixture) -> WindowInfo {
    let pid = ProcessId::from(fixture.process_id());
    let token = process_identity::token_for_pid(pid)
        .expect("token read")
        .expect("live token");
    let app = process_identity::process_image_name(pid).unwrap_or_default();
    WindowInfo {
        id: format!("w-{}", fixture.handle() as usize),
        title: String::new(),
        app,
        pid,
        process_instance: Some(token),
        bounds: None,
        state: WindowState::default(),
    }
}

/// Stages the fixture as foreground via the activation path. Tests may raise;
/// production `press_for_app_impl` never does.
#[cfg(target_os = "windows")]
pub(super) fn stage_as_foreground(fixture: &crate::tree::fixture::HostedFixture) -> bool {
    use crate::system::window::window_activate::focus_window;
    use agent_desktop_core::InteractionLease;

    let info = window_info_for_hosted(fixture);
    let lease = InteractionLease::guarded(deadline(10_000), ()).expect("lease");
    focus_window(&info, &lease).is_ok()
}

#[cfg(target_os = "windows")]
pub(super) fn assert_not_delivered(error: &AdapterError) {
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("physical_delivery_started")),
        Some(&serde_json::Value::Bool(false))
    );
}

/// The assertion for a desktop that would not give the target the foreground.
///
/// Staging depends on real OS scheduling and is documented as able not to
/// land, but "could not stage" must never become "asserted nothing": Windows
/// `SendInput` has no per-pid targeting, so a target that is not foreground
/// must fail closed with no synthesis. Every gated test asserts that instead
/// of returning, so the degraded desktop still exercises a real contract.
#[cfg(target_os = "windows")]
pub(super) fn assert_press_fails_closed_without_synthesis(
    identity: agent_desktop_core::ProcessIdentity,
    policy: InteractionPolicy,
) {
    synthesis_probe::reset();
    let error = press_for_app_impl(identity, &combo_a(), policy, deadline(10_000))
        .expect_err("a target that is not foreground cannot be delivered to");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_not_delivered(&error);
    assert_eq!(
        synthesis_probe::count(),
        0,
        "no key may be synthesized when the target never held the foreground"
    );
}

#[test]
fn key_dispatch_never_calls_activation_apis() {
    let src = include_str!("key_dispatch.rs");
    assert!(
        !src.contains("focus_window"),
        "verify-only path must not call focus_window"
    );
    assert!(
        !src.contains("window_activate"),
        "verify-only path must not call window_activate"
    );
    assert!(
        !src.contains("SetForegroundWindow"),
        "verify-only path must not raise via SetForegroundWindow"
    );
}

#[test]
fn press_key_base_policy_is_focus_fallback_matching_ffi_default() {
    let combo = KeyCombo {
        key: "a".into(),
        modifiers: vec![],
    };
    assert_eq!(
        Action::PressKey(combo).base_interaction_policy(),
        InteractionPolicy::focus_fallback(),
        "FFI explicit PressKey joins this base; must remain focus_fallback"
    );
    let ffi_docs = include_str!("../../../ffi/src/commands/execute_by_ref.rs");
    assert!(
        ffi_docs.contains("Explicit `PressKey` defaults to `focus_fallback`"),
        "FFI by-ref surface must still name focus_fallback as the PressKey default"
    );
    let execute = include_str!("../../../ffi/src/actions/execute.rs");
    assert!(
        execute.contains("ActionRequest::focus_fallback(action)"),
        "FFI execute.rs must still map FocusFallback to InteractionPolicy::focus_fallback"
    );
}

#[test]
fn all_three_interaction_policies_are_constructible_and_distinct() {
    let headless = InteractionPolicy::headless();
    let focus_fallback = InteractionPolicy::focus_fallback();
    let headed = InteractionPolicy::headed();
    assert!(!headless.allow_focus_steal);
    assert!(!headless.allow_cursor_move);
    assert!(focus_fallback.allow_focus_steal);
    assert!(!focus_fallback.allow_cursor_move);
    assert!(!focus_fallback.is_headed());
    assert!(headed.allow_focus_steal);
    assert!(headed.allow_cursor_move);
    assert!(headed.is_headed());
}

#[cfg(target_os = "windows")]
#[test]
fn headed_foreground_target_synthesizes_delivered_unverified() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, identity) = staged_hosted_target();
    if !stage_as_foreground(&fixture) {
        assert_press_fails_closed_without_synthesis(identity, InteractionPolicy::headed());
        return;
    }
    synthesis_probe::reset();
    let result = press_for_app_impl(
        identity,
        &combo_a(),
        InteractionPolicy::headed(),
        deadline(10_000),
    )
    .expect("foreground headed press");
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
    assert_eq!(result.action, "press_key");
    assert_eq!(synthesis_probe::count(), 1);
}

#[cfg(target_os = "windows")]
#[test]
fn headless_foreground_target_verifies_without_stealing() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, identity) = staged_hosted_target();
    if !stage_as_foreground(&fixture) {
        assert_press_fails_closed_without_synthesis(identity, InteractionPolicy::headless());
        return;
    }
    synthesis_probe::reset();
    let result = press_for_app_impl(
        identity,
        &combo_a(),
        InteractionPolicy::headless(),
        deadline(10_000),
    )
    .expect("already-foreground headless press");
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
    assert_eq!(synthesis_probe::count(), 1);
    let src = include_str!("key_dispatch.rs");
    assert!(!src.contains("SetForegroundWindow"));
}

#[cfg(target_os = "windows")]
#[test]
fn headless_background_target_fails_closed_without_synthesis() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (target, identity) = staged_hosted_target();
    let stealer = crate::tree::fixture::LocalFixture::create().expect("stealer");
    raise_handle(stealer.handle());
    synthesis_probe::reset();
    let error = press_for_app_impl(
        identity,
        &combo_a(),
        InteractionPolicy::headless(),
        deadline(10_000),
    )
    .expect_err("background headless must fail closed");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_not_delivered(&error);
    assert!(
        error.message.contains("not foreground") || error.message.contains("SendInput"),
        "headless background refusal must name the SendInput divergence, got {}",
        error.message
    );
    assert_eq!(synthesis_probe::count(), 0);
    let _ = target;
}

#[cfg(target_os = "windows")]
#[test]
fn focus_fallback_background_target_fails_closed_without_activation() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (target, identity) = staged_hosted_target();
    let stealer = crate::tree::fixture::LocalFixture::create().expect("stealer");
    raise_handle(stealer.handle());
    synthesis_probe::reset();
    let error = press_for_app_impl(
        identity,
        &combo_a(),
        InteractionPolicy::focus_fallback(),
        deadline(10_000),
    )
    .expect_err("focus_fallback does not activate; background fails closed");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_not_delivered(&error);
    assert_eq!(synthesis_probe::count(), 0);
    let _ = target;
}

#[cfg(target_os = "windows")]
#[test]
fn higher_integrity_is_perm_denied_not_delivered_before_synthesis() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (_fixture, identity) = staged_hosted_target();
    synthesis_probe::reset();
    let error = force_higher_integrity::with(|| {
        press_for_app_impl(
            identity,
            &combo_a(),
            InteractionPolicy::headed(),
            deadline(10_000),
        )
        .expect_err("higher integrity")
    });
    assert_eq!(error.code, ErrorCode::PermDenied);
    assert_not_delivered(&error);
    assert!(
        error.message.contains("integrity"),
        "must use the input-worded elevation denial, got {}",
        error.message
    );
    assert_eq!(synthesis_probe::count(), 0);
}

#[cfg(target_os = "windows")]
#[test]
fn focus_lost_between_verify_and_inject_fails_closed_without_synthesis() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (target, identity) = staged_hosted_target();
    let stealer = crate::tree::fixture::LocalFixture::create().expect("stealer");
    if !stage_as_foreground(&target) {
        assert_press_fails_closed_without_synthesis(identity, InteractionPolicy::headed());
        return;
    }
    let stealer_handle = stealer.handle();
    synthesis_probe::reset();
    let error = force_focus_lost::with_armed_after_hook(
        move || raise_handle(stealer_handle),
        || {
            press_for_app_impl(
                identity,
                &combo_a(),
                InteractionPolicy::headed(),
                deadline(10_000),
            )
            .expect_err("focus lost")
        },
    );
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_not_delivered(&error);
    assert!(
        error.message.contains("lost focus"),
        "focus-lost refusal must name the lost-focus condition, got {}",
        error.message
    );
    assert_eq!(synthesis_probe::count(), 0);
}

#[cfg(target_os = "windows")]
#[test]
fn adapter_press_key_for_app_is_wired_through_system_ops() {
    use agent_desktop_core::{InteractionLease, SystemOps};

    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, identity) = staged_hosted_target();
    let staged = stage_as_foreground(&fixture);
    let adapter = crate::adapter::WindowsAdapter::new();
    let lease = InteractionLease::guarded(deadline(10_000), ()).expect("lease");
    let outcome = SystemOps::press_key_for_app(
        &adapter,
        identity,
        &combo_a(),
        InteractionPolicy::headed(),
        &lease,
    );

    match outcome {
        Ok(result) => {
            assert!(
                staged,
                "delivery may only succeed for a target that reached the foreground"
            );
            assert_eq!(
                result.disposition().delivery(),
                DeliveryDisposition::DeliveredUnverified
            );
        }
        Err(error) => {
            assert!(
                !staged,
                "a staged foreground target must not be refused, got {}",
                error.message
            );
            assert_eq!(error.code, ErrorCode::ActionFailed);
            assert_not_delivered(&error);
        }
    }
}
