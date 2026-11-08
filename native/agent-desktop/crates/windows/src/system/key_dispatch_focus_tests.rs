#[cfg(target_os = "windows")]
use super::tests::{
    assert_not_delivered, assert_press_fails_closed_without_synthesis, combo_a, deadline,
    stage_as_foreground, staged_hosted_target,
};
use super::*;

#[cfg(target_os = "windows")]
#[test]
fn keyboard_focus_never_verified_times_out_without_synthesis() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, identity) = staged_hosted_target();
    if !stage_as_foreground(&fixture) {
        assert_press_fails_closed_without_synthesis(identity, InteractionPolicy::headed());
        return;
    }
    synthesis_probe::reset();
    let error = force_keyboard_focus_denied::with(|| {
        press_for_app_impl(
            identity,
            &combo_a(),
            InteractionPolicy::headed(),
            deadline(10_000),
        )
        .expect_err("keyboard focus never verifies")
    });
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_not_delivered(&error);
    assert!(
        error.message.contains("keyboard focus"),
        "must name the keyboard-focus verification gate, got {}",
        error.message
    );
    assert_eq!(
        synthesis_probe::count(),
        0,
        "no key may be synthesized when keyboard focus is never verified"
    );
}
