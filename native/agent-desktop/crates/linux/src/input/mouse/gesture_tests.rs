use super::*;
use crate::input::keyboard::keymap::Keymap;
use crate::input::mouse::pointer_plan::{CLICK_GAP, CLICK_HOLD, plan_click};
use agent_desktop_core::{MouseButton, Point};

fn click(count: u32) -> Plan {
    plan_click(
        &Keymap::sample(),
        Point { x: 10.0, y: 20.0 },
        &MouseButton::Left,
        count,
        &[],
    )
    .unwrap()
}

fn presses(plan: &Plan) -> usize {
    plan.steps
        .iter()
        .filter(|step| matches!(step, Step::Button { down: true, .. }))
        .count()
}

#[test]
fn a_multi_click_plan_is_split_so_each_press_starts_a_plan() {
    for count in [2u32, 3] {
        let gesture = Gesture::clicks(vec![click(count)]);
        assert_eq!(gesture.plans.len(), count as usize);
        assert!(gesture.plans.iter().all(|plan| presses(plan) == 1));
        assert!(
            gesture
                .plans
                .iter()
                .all(|plan| plan.release_origin == Some((10, 20)))
        );
        assert!(matches!(gesture.plans[0].steps[0], Step::MoveTo { .. }));
        for plan in &gesture.plans[1..] {
            assert!(matches!(plan.steps[0], Step::Button { down: true, .. }));
        }
        assert_eq!(gesture.press_budget, Some(PRESS_TO_PRESS_BUDGET));
    }
}

#[test]
fn the_hold_and_the_gap_stay_between_the_presses() {
    let gesture = Gesture::clicks(vec![click(2)]);
    let first = &gesture.plans[0].steps;
    assert_eq!(first.last(), Some(&Step::Pause(CLICK_GAP)));
    assert!(first.contains(&Step::Pause(CLICK_HOLD)));
    assert!(!gesture.plans[1].steps.contains(&Step::Pause(CLICK_GAP)));
}

#[test]
fn a_single_click_and_a_wheel_gesture_are_not_split() {
    let single = Gesture::clicks(vec![click(1)]);
    assert_eq!(single.plans, vec![click(1)]);
    let unbounded = Gesture::unbounded(vec![click(3)]);
    assert_eq!(unbounded.plans.len(), 1);
    assert_eq!(unbounded.press_budget, None);
}
