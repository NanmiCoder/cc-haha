use agent_desktop_core::{Direction, ErrorCode, InteractionPolicy};

use super::{scroll_steps, wheel_deltas};
use crate::actions::physical_target::tests::fake::{FakeWorld, check_of, deadline, element};

#[test]
fn every_wheel_burst_revalidates_and_a_late_refusal_preserves_sent_clicks() {
    use crate::input::x11::fake_sink::{FakeSink, Recorded};
    use agent_desktop_core::{AdapterError, DeliverySemantics};
    use serde_json::json;

    for details in [
        json!({"check": "receives_events", "interceptor": {"role": "button", "name": "Cover", "bounds": null}}),
        json!({"kind": "pointer_hit_unproven", "hit_test": "unknown"}),
    ] {
        for allowed in 0..=6 {
            let mut world = FakeWorld::x11();
            let sink = FakeSink::new();
            world.sink = Some(sink.clone());
            world
                .pointer_reads
                .borrow_mut()
                .extend((0..allowed).map(|_| Ok(())));
            world
                .pointer_reads
                .borrow_mut()
                .push_back(Err(AdapterError::new(
                    ErrorCode::ActionFailed,
                    "receiver changed",
                )
                .with_details(details.clone())
                .with_disposition(DeliverySemantics::not_delivered())));
            let result = scroll_steps(
                &world,
                &element(),
                (0.0, -21.0),
                InteractionPolicy::headed(),
                deadline(),
            );
            let sent = sink
                .recorded()
                .iter()
                .filter(|event| matches!(event, Recorded::Button(5, true)))
                .count();
            let expected = (allowed / 2 * 10).min(21);
            assert_eq!(sent, expected, "allowed bursts: {allowed}");
            if allowed == 6 {
                result.expect("all three receivers were proven");
            } else {
                let error = result.expect_err("a receiver refusal stops the wheel");
                assert_eq!(
                    error.disposition,
                    if allowed == 0 {
                        DeliverySemantics::not_delivered()
                    } else {
                        DeliverySemantics::delivered_unverified()
                    }
                );
                let observed = error.details.expect("refusal evidence");
                for (key, value) in details.as_object().unwrap() {
                    assert_eq!(&observed[key], value);
                }
                if allowed > 0 {
                    assert_eq!(observed["delivered_clicks"], expected);
                    assert_eq!(observed["physical_delivery_started"], true);
                }
            }
        }
    }
}

#[test]
fn the_wheel_is_aimed_at_the_centre_of_the_targets_own_bounds() {
    let mut world = FakeWorld::x11();
    let sink = crate::input::x11::fake_sink::FakeSink::new();
    world.sink = Some(sink.clone());
    scroll_steps(
        &world,
        &element(),
        (0.0, -4.0),
        InteractionPolicy::headed(),
        deadline(),
    )
    .unwrap();
    assert!(
        sink.recorded()
            .contains(&crate::input::x11::fake_sink::Recorded::Move(120, 210))
    );
    assert_eq!(
        sink.recorded()
            .iter()
            .filter(|event| matches!(
                event,
                crate::input::x11::fake_sink::Recorded::Button(5, true)
            ))
            .count(),
        4
    );
    assert_eq!(world.count("keymap"), 0, "wheel input needs no keymap");
}

#[test]
fn bounds_that_cannot_be_established_refuse_with_no_event() {
    let world = FakeWorld::x11().with_bounds(None);
    let error = scroll_steps(
        &world,
        &element(),
        (0.0, -1.0),
        InteractionPolicy::headed(),
        deadline(),
    )
    .unwrap_err();
    assert_eq!(check_of(&error).as_deref(), Some("geometry"));
    assert!(world.sent_nothing());
}

#[test]
fn the_wheel_needs_the_cursor_and_focus_policy() {
    for policy in [
        InteractionPolicy::headless(),
        InteractionPolicy::focus_fallback(),
    ] {
        let world = FakeWorld::x11();
        let error = scroll_steps(&world, &element(), (0.0, -1.0), policy, deadline()).unwrap_err();
        assert_eq!(error.code, ErrorCode::PolicyDenied);
        assert!(world.sent_nothing());
    }
}

#[test]
fn on_wayland_the_wheel_is_refused_before_anything_is_computed() {
    let world = FakeWorld::wayland();
    let error = scroll_steps(
        &world,
        &element(),
        (0.0, -1.0),
        InteractionPolicy::headed(),
        deadline(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.message, "pointer_refusal scroll");
    assert_eq!(world.count("bounds"), 0);
    assert!(world.sent_nothing());
}

#[test]
fn every_direction_reaches_the_x_button_that_scrolls_that_way() {
    use crate::input::keyboard::keymap::Keymap;
    use crate::input::mouse::wheel_plan::{
        BUTTON_WHEEL_DOWN, BUTTON_WHEEL_LEFT, BUTTON_WHEEL_RIGHT, BUTTON_WHEEL_UP, plan_wheel,
    };
    use crate::input::step::Step;
    let at = agent_desktop_core::Point { x: 5.0, y: 5.0 };
    for (direction, button) in [
        (Direction::Up, BUTTON_WHEEL_UP),
        (Direction::Down, BUTTON_WHEEL_DOWN),
        (Direction::Left, BUTTON_WHEEL_LEFT),
        (Direction::Right, BUTTON_WHEEL_RIGHT),
    ] {
        let (dx, dy) = wheel_deltas(&direction, 1);
        let plans = plan_wheel(&Keymap::sample(), at.clone(), dx, dy, &[]).expect("plan");
        let pressed: Vec<u8> = plans
            .iter()
            .flat_map(|plan| &plan.steps)
            .filter_map(|step| match step {
                Step::Button { code, down: true } => Some(*code),
                _ => None,
            })
            .collect();
        assert_eq!(pressed, vec![button], "{direction:?}");
    }
}
