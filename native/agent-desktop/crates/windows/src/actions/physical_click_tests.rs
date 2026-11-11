use super::{ClickGate, ClickSpec, click_from_gate};
use crate::actions::physical_target::delivery_point;
use crate::input::mouse::mouse_send::{
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
};
use crate::input::mouse_send_fake_sink as mouse_sink;
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{
    ActionStepOutcome, DeliveryDisposition, ErrorCode, MouseButton, Point, Rect, StepMechanism,
};

const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;

fn bounds() -> Rect {
    Rect {
        x: 10.0,
        y: 20.0,
        width: 100.0,
        height: 40.0,
    }
}

#[test]
fn delivery_point_centers_without_a_verified_point() {
    assert_eq!(
        delivery_point(bounds(), None).unwrap(),
        Point { x: 60.0, y: 40.0 }
    );
}

#[test]
fn delivery_point_rejects_a_verified_point_outside_live_bounds() {
    let stale = Point { x: 9.0, y: 30.0 };
    let error = delivery_point(bounds(), Some(&stale)).unwrap_err();
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn lost_foreground_fails_not_delivered_with_zero_injection() {
    mouse_sink::reset();

    let error = click_from_gate(
        ClickGate {
            bounds: bounds(),
            foreground_ready: false,
        },
        None,
        ClickSpec {
            button: MouseButton::Left,
            count: 2,
        },
        deadline(5_000),
    )
    .expect_err("lost foreground");

    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert!(mouse_sink::recorded().is_empty());
}

#[test]
fn double_click_issues_left_button_down_up_pairs() {
    mouse_sink::reset();

    let step = click_from_gate(
        ClickGate {
            bounds: bounds(),
            foreground_ready: true,
        },
        None,
        ClickSpec {
            button: MouseButton::Left,
            count: 2,
        },
        deadline(5_000),
    )
    .expect("double click");

    assert_eq!(step.label(), "SendInput.click");
    assert_eq!(step.mechanism(), Some(StepMechanism::PhysicalSynthetic));
    assert_eq!(step.verified(), Some(false));
    assert!(matches!(step.outcome, ActionStepOutcome::Succeeded));

    let recorded = mouse_sink::recorded();
    assert_eq!(recorded.len(), 1 + 2 * 2, "move + two click cycles");
    assert_eq!(recorded[0].flags & MOUSEEVENTF_MOVE, MOUSEEVENTF_MOVE);
    assert_eq!(
        recorded[0].flags & MOUSEEVENTF_ABSOLUTE,
        MOUSEEVENTF_ABSOLUTE
    );
    let downs = recorded
        .iter()
        .filter(|event| event.flags == MOUSEEVENTF_LEFTDOWN)
        .count();
    let ups = recorded
        .iter()
        .filter(|event| event.flags == MOUSEEVENTF_LEFTUP)
        .count();
    assert_eq!(downs, 2);
    assert_eq!(ups, 2);
}

#[test]
fn triple_click_issues_three_left_button_cycles() {
    mouse_sink::reset();

    click_from_gate(
        ClickGate {
            bounds: bounds(),
            foreground_ready: true,
        },
        None,
        ClickSpec {
            button: MouseButton::Left,
            count: 3,
        },
        deadline(5_000),
    )
    .expect("triple click");

    let downs = mouse_sink::recorded()
        .iter()
        .filter(|event| event.flags == MOUSEEVENTF_LEFTDOWN)
        .count();
    assert_eq!(downs, 3);
}

#[test]
fn right_click_issues_right_button_flags() {
    mouse_sink::reset();

    click_from_gate(
        ClickGate {
            bounds: bounds(),
            foreground_ready: true,
        },
        None,
        ClickSpec {
            button: MouseButton::Right,
            count: 1,
        },
        deadline(5_000),
    )
    .expect("right click");

    let recorded = mouse_sink::recorded();
    assert!(
        recorded
            .iter()
            .any(|event| event.flags == MOUSEEVENTF_RIGHTDOWN),
        "expected a right-button down"
    );
    assert!(
        recorded
            .iter()
            .any(|event| event.flags == MOUSEEVENTF_RIGHTUP),
        "expected a right-button up"
    );
    assert!(
        !recorded
            .iter()
            .any(|event| event.flags == MOUSEEVENTF_LEFTDOWN),
        "right click must not emit left-button down"
    );
}
