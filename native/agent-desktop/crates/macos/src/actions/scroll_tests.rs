use std::cell::Cell;

use agent_desktop_core::{AdapterError, Direction, ErrorCode};

use super::repeat_action;

#[test]
fn horizontal_wheel_delta_matches_direction() {
    assert_eq!(super::scroll_wheel_delta(&Direction::Right, 2), (0, 2));
    assert_eq!(super::scroll_wheel_delta(&Direction::Left, 2), (0, -2));
}

#[test]
fn wheel_delta_saturates_without_integer_wraparound() {
    assert_eq!(
        super::scroll_wheel_delta(&Direction::Down, u32::MAX),
        (-i32::MAX, 0)
    );
}

#[test]
fn semantic_scroll_actions_and_value_fallback_preserve_direction() {
    assert_eq!(
        super::scroll_bar_action(&Direction::Down),
        ("AXVerticalScrollBar", "AXIncrement")
    );
    assert_eq!(
        super::scroll_bar_action(&Direction::Up),
        ("AXVerticalScrollBar", "AXDecrement")
    );
    assert_eq!(super::page_action(&Direction::Down), "AXScrollDownByPage");
    assert_eq!(super::page_action(&Direction::Up), "AXScrollUpByPage");
    assert!((super::shifted_value(0.0, &Direction::Down, 1) - 0.1).abs() < f64::EPSILON);
    assert!(super::shifted_value(0.1, &Direction::Up, 1).abs() < f64::EPSILON);
    assert!(super::value_shift_verified(0.2, 0.3, &Direction::Down));
    assert!(super::value_shift_verified(0.3, 0.2, &Direction::Up));
    assert!(super::value_shift_verified(0.2, 0.3, &Direction::Right));
    assert!(super::value_shift_verified(0.3, 0.2, &Direction::Left));
    assert!(!super::value_shift_verified(0.2, 0.2, &Direction::Down));
    assert!(!super::value_shift_verified(0.2, 0.1, &Direction::Down));
}

#[test]
fn repeated_scroll_stops_after_partial_definite_failure() {
    let calls = Cell::new(0);
    let error = repeat_action("AXIncrement", 3, || {
        calls.set(calls.get() + 1);
        Ok(calls.get() == 1)
    })
    .unwrap_err();

    assert_eq!(calls.get(), 2);
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.details.as_ref().unwrap()["action_may_have_completed"],
        true
    );
    assert_eq!(error.details.as_ref().unwrap()["completed_steps"], 1);
    assert_eq!(error.details.as_ref().unwrap()["requested_steps"], 3);
}

#[test]
fn repeated_scroll_allows_fallback_only_before_any_delivery() {
    let calls = Cell::new(0);
    let delivered = repeat_action("AXIncrement", 3, || {
        calls.set(calls.get() + 1);
        Ok(false)
    })
    .unwrap();

    assert!(!delivered);
    assert_eq!(calls.get(), 1);
}

#[test]
fn repeated_scroll_propagates_uncertain_mutation_without_another_attempt() {
    let calls = Cell::new(0);
    let error = repeat_action("AXIncrement", 3, || {
        calls.set(calls.get() + 1);
        if calls.get() == 2 {
            return Err(AdapterError::new(ErrorCode::AppUnresponsive, "uncertain")
                .with_details(serde_json::json!({ "action_may_have_completed": true })));
        }
        Ok(true)
    })
    .unwrap_err();

    assert_eq!(calls.get(), 2);
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(
        error.details.as_ref().unwrap()["action_may_have_completed"],
        true
    );
}
