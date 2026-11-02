#[path = "physical_fake.rs"]
pub(crate) mod fake;

use agent_desktop_core::{Action, ActionRequest, DragParams, ErrorCode, KeyCombo, Point};

use super::deliver_in;
use crate::input::deliver::{ensure_headed_click_policy, ensure_keyboard_policy};
use agent_desktop_core::InteractionPolicy;
use fake::{FakeWorld, deadline, element, not_delivered};

fn combo() -> KeyCombo {
    KeyCombo {
        key: "a".to_owned(),
        modifiers: Vec::new(),
    }
}

fn run(
    world: &FakeWorld,
    action: Action,
    with_element: bool,
) -> Result<(), agent_desktop_core::AdapterError> {
    let request = ActionRequest::headed(action.clone());
    let target = element();
    deliver_in(
        world,
        &action,
        with_element.then_some(&target),
        &request,
        deadline(),
    )
    .map(|_| ())
}

#[test]
fn hover_and_drag_are_rejected_at_the_adapter_with_nothing_sent() {
    let drag = Action::Drag(DragParams {
        from: Point { x: 0.0, y: 0.0 },
        to: Point { x: 1.0, y: 1.0 },
        duration_ms: None,
        drop_delay_ms: None,
    });
    for action in [Action::Hover, drag] {
        let world = FakeWorld::x11();
        let error = run(&world, action, true).unwrap_err();
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert!(error.message.contains("adapter-level handling"));
        assert!(not_delivered(&error));
        assert!(world.sent_nothing());
        assert!(world.entries().is_empty());
    }
}

#[test]
fn held_key_edges_are_rejected_at_the_adapter() {
    for action in [Action::KeyDown(combo()), Action::KeyUp(combo())] {
        let world = FakeWorld::x11();
        let error = run(&world, action, false).unwrap_err();
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert!(world.sent_nothing());
    }
}

#[test]
fn an_action_with_no_physical_leg_is_not_supported_with_nothing_sent() {
    for action in [
        Action::SetValue("x".to_owned()),
        Action::Toggle,
        Action::Clear,
    ] {
        let world = FakeWorld::x11();
        let error = run(&world, action, true).unwrap_err();
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert!(world.sent_nothing());
    }
}

#[test]
fn a_ref_action_without_an_element_is_invalid() {
    let world = FakeWorld::x11();
    let error = run(&world, Action::Click, false).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(world.sent_nothing());
}

#[test]
fn a_null_handle_press_sends_with_no_gate_even_under_headless_policy() {
    let world = FakeWorld::x11().active_script(&[Some(false)]);
    let action = Action::PressKey(combo());
    let request = ActionRequest::headless(action.clone());
    let result = deliver_in(&world, &action, None, &request, deadline()).unwrap();
    assert_eq!(result.steps[0].label(), "XTEST.press_key");
    assert_eq!(world.count("read_active"), 0);
    assert_eq!(world.count("sent"), 1);
}

#[test]
fn the_policies_split_keys_from_the_pointer() {
    assert!(ensure_keyboard_policy(InteractionPolicy::headless()).is_err());
    assert!(ensure_keyboard_policy(InteractionPolicy::focus_fallback()).is_ok());
    assert!(ensure_headed_click_policy(InteractionPolicy::focus_fallback()).is_err());
    assert!(ensure_headed_click_policy(InteractionPolicy::headed()).is_ok());
}

#[test]
fn a_non_finite_verified_point_is_refused_before_it_is_aimed_at() {
    let world = FakeWorld::x11();
    let point = Point {
        x: f64::NAN,
        y: 1.0,
    };
    let error = aim_point(&world, &element(), Some(&point), deadline()).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

use crate::input::physical::target_pointer::aim_point;
