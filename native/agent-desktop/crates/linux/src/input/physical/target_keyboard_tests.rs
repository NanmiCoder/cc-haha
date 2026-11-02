use agent_desktop_core::{AdapterError, ErrorCode, InteractionPolicy, KeyCombo};

use super::{press_for_process, press_key_global_steps, target_steps};
use crate::input::physical::target_world::PhysicalWorld;
use crate::tree::AtspiElement;
use agent_desktop_core::{Action, ActionStep, Deadline};

fn type_text_steps(
    world: &impl PhysicalWorld,
    element: &AtspiElement,
    text: &str,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<ActionStep>, AdapterError> {
    target_steps(
        world,
        element,
        &Action::TypeText(text.to_owned()),
        policy,
        deadline,
    )
}

fn press_key_element_steps(
    world: &impl PhysicalWorld,
    element: &AtspiElement,
    combo: &KeyCombo,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<ActionStep>, AdapterError> {
    target_steps(
        world,
        element,
        &Action::PressKey(combo.clone()),
        policy,
        deadline,
    )
}
use crate::actions::physical_target::tests::fake::{
    FakeWorld, check_of, deadline, element, expired, not_delivered,
};

fn combo() -> KeyCombo {
    KeyCombo {
        key: "a".to_owned(),
        modifiers: Vec::new(),
    }
}

#[test]
fn empty_typing_is_satisfied_without_delivery_or_focus_changes() {
    use agent_desktop_core::{Action, ActionRequest, DeliverySemantics};
    for world in [FakeWorld::x11(), FakeWorld::wayland()] {
        let result = crate::actions::physical_target::deliver_in(
            &world,
            &Action::TypeText(String::new()),
            Some(&element()),
            &ActionRequest::headed(Action::TypeText(String::new())),
            deadline(),
        )
        .expect("empty insertion is already satisfied");
        assert_eq!(result.disposition(), DeliverySemantics::not_delivered());
        assert!(
            world.entries().is_empty(),
            "no focus, planning or input: {:?}",
            world.entries()
        );
    }
}

#[test]
fn headless_type_is_denied_by_policy_and_sends_nothing() {
    let world = FakeWorld::x11();
    let error = type_text_steps(
        &world,
        &element(),
        "hi",
        InteractionPolicy::headless(),
        deadline(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert!(world.sent_nothing());
    assert_eq!(world.count("read_active"), 0);
}

#[test]
fn headless_press_on_an_element_is_denied_by_policy() {
    let world = FakeWorld::x11();
    let error = press_key_element_steps(
        &world,
        &element(),
        &combo(),
        InteractionPolicy::headless(),
        deadline(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert!(world.sent_nothing());
}

#[test]
fn focus_only_policy_lets_keys_through() {
    let world = FakeWorld::x11();
    let steps = type_text_steps(
        &world,
        &element(),
        "hi",
        InteractionPolicy::focus_fallback(),
        deadline(),
    )
    .unwrap();
    assert_eq!(steps[0].label(), "XTEST.type_text");
    assert_eq!(steps[0].verified(), Some(false));
    assert_eq!(world.count("sent"), 1);
}

#[test]
fn a_frame_that_never_reports_active_fails_with_nothing_sent() {
    let world = FakeWorld::x11().active_script(&[Some(false)]);
    let error = type_text_steps(
        &world,
        &element(),
        "hi",
        InteractionPolicy::headed(),
        deadline(),
    )
    .unwrap_err();
    assert_eq!(check_of(&error).as_deref(), Some("window_active"));
    assert!(not_delivered(&error));
    assert!(world.sent_nothing());
}

#[test]
fn a_frame_that_becomes_active_after_two_polls_proceeds() {
    let world = FakeWorld::x11().active_script(&[Some(false), Some(false), Some(true)]);
    type_text_steps(
        &world,
        &element(),
        "hi",
        InteractionPolicy::headed(),
        deadline(),
    )
    .unwrap();
    assert_eq!(world.count("sent"), 1);
}

#[test]
fn a_frame_that_loses_active_before_the_third_chunk_stops_after_two() {
    let world = FakeWorld::x11().active_script(&[Some(true), Some(true), Some(true), Some(false)]);
    let error = type_text_steps(
        &world,
        &element(),
        &"a".repeat(65),
        InteractionPolicy::headed(),
        deadline(),
    )
    .unwrap_err();
    assert_eq!(check_of(&error).as_deref(), Some("window_active"));
    assert_eq!(world.count("sent"), 2);
}

#[test]
fn the_gate_is_read_before_the_first_key_on_the_press_leg_too() {
    let world = FakeWorld::x11().active_script(&[Some(false)]);
    let error = press_key_element_steps(
        &world,
        &element(),
        &combo(),
        InteractionPolicy::focus_fallback(),
        deadline(),
    )
    .unwrap_err();
    assert_eq!(check_of(&error).as_deref(), Some("window_active"));
    assert!(world.sent_nothing());
}

#[test]
fn a_global_press_sends_with_no_gate_and_no_frame_read() {
    let world = FakeWorld::x11().active_script(&[Some(false)]);
    let steps = press_key_global_steps(&world, &combo(), deadline()).unwrap();
    assert_eq!(steps[0].label(), "XTEST.press_key");
    assert_eq!(world.count("read_active"), 0);
    assert_eq!(world.count("sent"), 1);
}

#[test]
fn an_expired_deadline_fails_before_any_event() {
    let world = FakeWorld::x11();
    let error = press_key_global_steps(&world, &combo(), expired()).unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(not_delivered(&error));
    assert!(world.sent_nothing());
}

#[test]
fn wayland_keys_go_through_the_keysym_sender_after_target_focus_preflight() {
    let world = FakeWorld::wayland();
    let steps = type_text_steps(
        &world,
        &element(),
        &"a".repeat(33),
        InteractionPolicy::focus_fallback(),
        deadline(),
    )
    .unwrap();
    assert_eq!(steps[0].label(), "RemoteDesktop.type_text");
    assert_eq!(world.count("keymap"), 0);
    assert_eq!(world.count("sent"), 2);
}

#[test]
fn headed_element_keys_focus_the_target_and_refuse_unproven_or_lost_focus() {
    for press in [false, true] {
        for wayland in [false, true] {
            for reads in [
                vec![false, true, true, true],
                vec![false],
                vec![true, false],
                vec![true, true, false],
            ] {
                let world = if wayland {
                    FakeWorld::wayland()
                } else {
                    FakeWorld::x11()
                };
                *world.focus_reads.borrow_mut() = reads.iter().copied().collect();
                let outcome = if press {
                    press_key_element_steps(
                        &world,
                        &element(),
                        &combo(),
                        InteractionPolicy::headed(),
                        deadline(),
                    )
                } else {
                    type_text_steps(
                        &world,
                        &element(),
                        " ",
                        InteractionPolicy::headed(),
                        deadline(),
                    )
                };
                assert_eq!(world.count("focus_target"), usize::from(!reads[0]));
                if !reads[0] && reads.len() > 1 {
                    outcome.expect("focus is acquired and proven before typing");
                    let entries = world.entries();
                    assert!(
                        entries.iter().position(|e| e == "focus_target").unwrap()
                            < entries.iter().position(|e| e == "sent").unwrap()
                    );
                    assert_eq!(world.count("sent"), 1);
                } else {
                    let error =
                        outcome.expect_err("an active window alone never authorizes typing");
                    assert_eq!(check_of(&error).as_deref(), Some("target_focus"));
                    assert!(not_delivered(&error));
                    assert!(world.sent_nothing());
                }
            }
        }
    }
}

#[test]
fn an_unreadable_frame_on_wayland_refuses_an_element_addressed_call_and_an_inactive_one_too() {
    for read in [None, Some(false)] {
        let world = FakeWorld::wayland().active_script(&[read]);
        let error = type_text_steps(
            &world,
            &element(),
            "hi",
            InteractionPolicy::focus_fallback(),
            deadline(),
        )
        .unwrap_err();
        assert_eq!(check_of(&error).as_deref(), Some("window_active"));
        assert!(not_delivered(&error));
        assert!(world.sent_nothing());

        let press = FakeWorld::wayland().active_script(&[read]);
        let error = press_key_element_steps(
            &press,
            &element(),
            &combo(),
            InteractionPolicy::focus_fallback(),
            deadline(),
        )
        .unwrap_err();
        assert_eq!(check_of(&error).as_deref(), Some("window_active"));
        assert!(not_delivered(&error));
        assert!(press.sent_nothing());
    }
}

#[test]
fn a_global_press_on_wayland_sends_with_no_frame_read_and_is_marked_unverified() {
    let world = FakeWorld::wayland().active_script(&[None]);
    let steps = press_key_global_steps(&world, &combo(), deadline()).unwrap();
    assert_eq!(steps[0].label(), "RemoteDesktop.press_key");
    assert_eq!(steps[0].verified(), Some(false));
    assert_eq!(world.count("read_active"), 0);
    assert_eq!(world.count("sent"), 1);
}

#[test]
fn a_process_press_under_a_passing_gate_ignores_the_focus_steal_policy() {
    let world = FakeWorld::x11();
    let result = press_for_process(
        &world,
        &combo(),
        InteractionPolicy::headless(),
        &mut || Ok(()),
        deadline(),
    )
    .unwrap();
    assert_eq!(result.steps[0].verified(), Some(false));
    assert_eq!(world.count("sent"), 1);
}

#[test]
fn a_process_press_runs_the_gate_before_the_plan_is_read_or_sent() {
    let world = FakeWorld::x11();
    let error = press_for_process(
        &world,
        &combo(),
        InteractionPolicy::headed(),
        &mut || Err(AdapterError::new(ErrorCode::ActionFailed, "gate")),
        deadline(),
    )
    .unwrap_err();
    assert_eq!(error.message, "gate");
    assert_eq!(world.count("keymap"), 0);
    assert!(world.sent_nothing());
}
