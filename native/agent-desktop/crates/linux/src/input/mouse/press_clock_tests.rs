use super::*;
use crate::actions::physical_target::tests::fake::{deadline, expired};
use std::time::Duration;

const BUDGET: Duration = Duration::from_millis(40);

#[test]
fn an_unbounded_gesture_and_a_first_press_keep_the_command_deadline() {
    let command = deadline();
    let mut unbounded = PressClock::new(None);
    unbounded.pressed();
    assert_eq!(unbounded.check_deadline(command).unwrap(), command);
    let first = PressClock::new(Some(BUDGET));
    assert_eq!(first.check_deadline(command).unwrap(), command);
}

#[test]
fn the_check_after_a_press_is_cut_to_what_is_left_of_the_budget() {
    let command = deadline();
    let mut clock = PressClock::new(Some(Duration::from_secs(10)));
    clock.pressed();
    let cut = clock.check_deadline(command).unwrap();
    assert!(cut.remaining() <= Duration::from_secs(10));
    assert!(cut.remaining() < command.remaining());
}

#[test]
fn a_spent_budget_refuses_before_any_check() {
    let mut clock = PressClock::new(Some(BUDGET));
    clock.pressed();
    std::thread::sleep(BUDGET + Duration::from_millis(10));
    let error = clock.check_deadline(deadline()).unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.details.unwrap()["kind"], "multi_click_window");
}

#[test]
fn only_a_check_that_outlived_its_budget_inside_a_live_command_is_the_window_elapsing() {
    let mut clock = PressClock::new(Some(BUDGET));
    clock.pressed();
    let live = deadline();
    let spent = live.capped(Duration::from_millis(1));
    std::thread::sleep(Duration::from_millis(5));
    let refusal = || AdapterError::new(ErrorCode::StaleRef, "not visible");
    let window = clock.explain(refusal(), spent, live);
    assert_eq!(window.code, ErrorCode::ActionFailed);
    assert_eq!(window.details.unwrap()["kind"], "multi_click_window");
    assert_eq!(
        clock.explain(refusal(), live, live).code,
        ErrorCode::StaleRef
    );
    assert_eq!(
        clock.explain(refusal(), expired(), expired()).code,
        ErrorCode::StaleRef
    );
    let mut unbounded = PressClock::new(None);
    unbounded.pressed();
    assert_eq!(
        unbounded.explain(refusal(), spent, live).code,
        ErrorCode::StaleRef
    );
    let before_press = PressClock::new(Some(BUDGET));
    assert_eq!(
        before_press.explain(refusal(), spent, live).code,
        ErrorCode::StaleRef
    );
}
