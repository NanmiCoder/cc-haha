use agent_desktop_core::Point;

use super::send_bursts;
use crate::actions::physical_target::tests::fake::{FakeWorld, deadline, element};

fn two_clicks_within(budget: std::time::Duration) -> crate::input::mouse::gesture::Gesture {
    use crate::input::keyboard::keymap::Keymap;
    use crate::input::mouse::pointer_plan::plan_click;
    use agent_desktop_core::MouseButton;

    let plan = plan_click(
        &Keymap::default(),
        Point { x: 120.0, y: 210.0 },
        &MouseButton::Left,
        2,
        &[],
    )
    .unwrap();
    let mut gesture = crate::input::mouse::gesture::Gesture::clicks(vec![plan]);
    gesture.press_budget = Some(budget);
    gesture
}

#[test]
fn a_budget_spent_between_two_presses_stops_the_gesture_after_the_first() {
    use crate::input::x11::fake_sink::{FakeSink, Recorded};
    use agent_desktop_core::DeliverySemantics;

    let mut world = FakeWorld::x11();
    let sink = FakeSink::new();
    world.sink = Some(sink.clone());
    let error = send_bursts(
        &world,
        &element(),
        &Point { x: 120.0, y: 210.0 },
        two_clicks_within(std::time::Duration::from_millis(5)),
        deadline(),
    )
    .expect_err("the hold and the gap outlast the budget");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let observed = error.details.expect("window evidence");
    assert_eq!(observed["kind"], "multi_click_window");
    assert_eq!(observed["delivered_clicks"], 1);
    assert_eq!(observed["physical_delivery_started"], true);
    let presses = sink
        .recorded()
        .iter()
        .filter(|event| matches!(event, Recorded::Button(1, true)))
        .count();
    assert_eq!(presses, 1);
}

#[test]
fn a_receiver_check_that_outlasts_the_budget_stops_the_gesture_after_the_first() {
    use crate::input::x11::fake_sink::{FakeSink, Recorded};
    use agent_desktop_core::DeliverySemantics;
    use std::time::Duration;

    let mut world = FakeWorld::x11();
    let sink = FakeSink::new();
    world.sink = Some(sink.clone());
    world.pointer_delays.borrow_mut().extend([
        Duration::ZERO,
        Duration::ZERO,
        Duration::from_millis(400),
    ]);
    let error = send_bursts(
        &world,
        &element(),
        &Point { x: 120.0, y: 210.0 },
        two_clicks_within(Duration::from_millis(150)),
        deadline(),
    )
    .expect_err("the second check cannot finish inside the budget");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let observed = error.details.expect("window evidence");
    assert_eq!(observed["kind"], "multi_click_window");
    assert_eq!(observed["delivered_clicks"], 1);
    let presses = sink
        .recorded()
        .iter()
        .filter(|event| matches!(event, Recorded::Button(1, true)))
        .count();
    assert_eq!(presses, 1);
}

#[test]
fn a_check_inside_the_budget_lets_both_presses_through() {
    use crate::input::x11::fake_sink::{FakeSink, Recorded};
    use std::time::Duration;

    let mut world = FakeWorld::x11();
    let sink = FakeSink::new();
    world.sink = Some(sink.clone());
    world.pointer_delays.borrow_mut().extend([
        Duration::ZERO,
        Duration::ZERO,
        Duration::from_millis(20),
    ]);
    send_bursts(
        &world,
        &element(),
        &Point { x: 120.0, y: 210.0 },
        two_clicks_within(Duration::from_millis(2_000)),
        deadline(),
    )
    .expect("the second check finished inside the budget");
    let presses = sink
        .recorded()
        .iter()
        .filter(|event| matches!(event, Recorded::Button(1, true)))
        .count();
    assert_eq!(presses, 2);
}
