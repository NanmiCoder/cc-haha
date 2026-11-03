use agent_desktop_core::{Action, DeliverySemantics, ErrorCode, MouseButton, Point, StepMechanism};

use super::*;

fn at() -> Point {
    Point { x: 1.0, y: 2.0 }
}

#[test]
fn a_click_on_a_shell_control_aims_the_left_button_through_the_shell_pointer() {
    let mut seen = None;
    let outcome = deliver_with(&Action::Click, |button| {
        seen = Some(button);
        Ok(at())
    });
    assert!(matches!(seen, Some(MouseButton::Left)));
    let result = outcome.expect("a click is taken").expect("delivered");
    assert_eq!(result.steps[0].label(), "shell-pointer");
    assert_eq!(
        result.steps[0].mechanism(),
        Some(StepMechanism::PhysicalSynthetic)
    );
    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn an_action_that_is_not_a_click_is_left_to_the_generic_path() {
    let mut called = false;
    let outcome = deliver_with(&Action::Toggle, |_| {
        called = true;
        Ok(at())
    });
    assert!(outcome.is_none());
    assert!(!called);
}

#[test]
fn a_refused_click_is_the_error_and_no_result() {
    let outcome = deliver_with(&Action::Click, |_| {
        Err(AdapterError::new(ErrorCode::ActionFailed, "refused"))
    });
    assert_eq!(
        outcome
            .expect("a click is taken")
            .expect_err("refused")
            .code,
        ErrorCode::ActionFailed
    );
}
