use super::fixture::{modifier_events, origin, reset_sinks};
use super::*;
use crate::input::keyboard::keyboard_send::keyboard_send_fake_sink as key_sink;
use crate::input::mouse::mouse_send::mouse_send_fake_sink as mouse_sink;
use crate::input::mouse::mouse_send::{
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK,
};
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{
    Deadline, DeliveryDisposition, ErrorCode, MAX_MOUSE_CLICK_COUNT, Modifier, MouseButton,
    MouseEvent, MouseEventKind, Point,
};

fn move_event(point: Point) -> MouseEvent {
    MouseEvent {
        kind: MouseEventKind::Move,
        point,
        button: MouseButton::Left,
        modifiers: Vec::new(),
    }
}

fn click_event(
    point: Point,
    count: u32,
    modifiers: Vec<Modifier>,
    button: MouseButton,
) -> MouseEvent {
    MouseEvent {
        kind: MouseEventKind::Click { count },
        point,
        button,
        modifiers,
    }
}

#[test]
fn move_posts_exactly_one_absolute_move_event() {
    reset_sinks();
    synthesize_mouse(move_event(origin()), deadline(1_000)).expect("move succeeds");

    let recorded = mouse_sink::recorded();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].flags & MOUSEEVENTF_MOVE, MOUSEEVENTF_MOVE);
    assert_eq!(
        recorded[0].flags & MOUSEEVENTF_ABSOLUTE,
        MOUSEEVENTF_ABSOLUTE
    );
}

#[test]
fn a_single_click_posts_a_move_then_one_down_up_pair() {
    reset_sinks();
    synthesize_mouse(
        click_event(origin(), 1, Vec::new(), MouseButton::Left),
        deadline(1_000),
    )
    .expect("click succeeds");

    let recorded = mouse_sink::recorded();
    assert_eq!(recorded.len(), 3, "move + down + up");
    assert_eq!(recorded[0].flags & MOUSEEVENTF_MOVE, MOUSEEVENTF_MOVE);
    assert_eq!(recorded[1].flags, MOUSEEVENTF_LEFTDOWN);
    assert_eq!(recorded[2].flags, MOUSEEVENTF_LEFTUP);
}

#[test]
fn a_triple_click_posts_a_move_then_three_down_up_pairs() {
    reset_sinks();
    synthesize_mouse(
        click_event(origin(), 3, Vec::new(), MouseButton::Left),
        deadline(1_000),
    )
    .expect("triple click succeeds");

    let recorded = mouse_sink::recorded();
    assert_eq!(recorded.len(), 1 + 3 * 2);
    let downs = recorded
        .iter()
        .filter(|event| event.flags == MOUSEEVENTF_LEFTDOWN)
        .count();
    let ups = recorded
        .iter()
        .filter(|event| event.flags == MOUSEEVENTF_LEFTUP)
        .count();
    assert_eq!(downs, 3);
    assert_eq!(ups, 3);
}

#[test]
fn right_button_click_uses_the_right_button_flags_never_the_left() {
    reset_sinks();
    synthesize_mouse(
        click_event(origin(), 1, Vec::new(), MouseButton::Right),
        deadline(1_000),
    )
    .expect("right click succeeds");

    let recorded = mouse_sink::recorded();
    assert!(
        recorded
            .iter()
            .any(|event| event.flags == MOUSEEVENTF_RIGHTDOWN)
    );
    assert!(
        recorded
            .iter()
            .any(|event| event.flags == MOUSEEVENTF_RIGHTUP)
    );
    assert!(
        !recorded
            .iter()
            .any(|event| event.flags == MOUSEEVENTF_LEFTDOWN || event.flags == MOUSEEVENTF_LEFTUP)
    );
}

#[test]
fn a_click_with_modifiers_holds_them_down_for_the_click_then_releases_them() {
    reset_sinks();
    synthesize_mouse(
        click_event(origin(), 1, vec![Modifier::Ctrl], MouseButton::Left),
        deadline(1_000),
    )
    .expect("modified click succeeds");

    let keys = modifier_events();
    assert_eq!(
        keys.first().map(|(_, up)| *up),
        Some(false),
        "the modifier must go down before the click"
    );
    assert_eq!(
        keys.last().map(|(_, up)| *up),
        Some(true),
        "the modifier must come back up after the click"
    );
}

#[test]
fn an_off_primary_move_sets_the_virtual_desktop_flag() {
    reset_sinks();
    synthesize_mouse(move_event(Point { x: -5.0, y: -5.0 }), deadline(1_000))
        .expect("off-primary move still succeeds");

    let recorded = mouse_sink::recorded();
    assert_eq!(recorded.len(), 1);
    assert_eq!(
        recorded[0].flags & MOUSEEVENTF_VIRTUALDESK,
        MOUSEEVENTF_VIRTUALDESK
    );
}

#[test]
fn a_primary_move_never_sets_the_virtual_desktop_flag() {
    reset_sinks();
    synthesize_mouse(move_event(origin()), deadline(1_000)).expect("primary move succeeds");

    let recorded = mouse_sink::recorded();
    assert_eq!(recorded[0].flags & MOUSEEVENTF_VIRTUALDESK, 0);
}

#[test]
fn an_expired_deadline_rejects_before_any_injection() {
    reset_sinks();
    let expired = Deadline::after(0).expect("zero-length deadline");

    let error = synthesize_mouse(
        click_event(origin(), 1, Vec::new(), MouseButton::Left),
        expired,
    )
    .expect_err("expired deadline");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(mouse_sink::recorded().is_empty());
    assert!(key_sink::recorded().is_empty());
}

#[test]
fn an_expired_deadline_mid_click_posts_corrective_up_with_enrichment() {
    reset_sinks();
    let tight = Deadline::after(8).expect("tight deadline");

    let error = synthesize_mouse(
        click_event(origin(), 1, Vec::new(), MouseButton::Left),
        tight,
    )
    .expect_err("deadline must abort mid-click");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
    let details = error.details.expect("abort-after-down enrichment");
    assert_eq!(details["delivered_events"], 1);
    assert_eq!(details["emergency_release_posted"], true);
    assert_eq!(details["emergency_release_acknowledged"], false);

    let recorded = mouse_sink::recorded();
    assert!(
        recorded
            .iter()
            .any(|event| event.flags == MOUSEEVENTF_LEFTDOWN),
        "down must have posted before abort"
    );
    assert!(
        recorded
            .iter()
            .any(|event| event.flags == MOUSEEVENTF_LEFTUP),
        "corrective up must post on abort"
    );
}

#[test]
fn down_is_rejected_as_a_standalone_state_error_with_zero_injection() {
    reset_sinks();
    let event = MouseEvent {
        kind: MouseEventKind::Down,
        point: origin(),
        button: MouseButton::Left,
        modifiers: Vec::new(),
    };
    let error = synthesize_mouse(event, deadline(1_000)).expect_err("standalone down is rejected");

    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    let details = error
        .details
        .as_ref()
        .expect("standalone error carries details");
    assert_eq!(details["raw_input_emitted"].as_bool(), Some(false));
    assert_eq!(
        details["requires_daemon_owned_transaction"].as_bool(),
        Some(true)
    );
    assert!(mouse_sink::recorded().is_empty());
}

#[test]
fn up_is_rejected_as_a_standalone_state_error_with_zero_injection() {
    reset_sinks();
    let event = MouseEvent {
        kind: MouseEventKind::Up,
        point: origin(),
        button: MouseButton::Left,
        modifiers: Vec::new(),
    };
    let error = synthesize_mouse(event, deadline(1_000)).expect_err("standalone up is rejected");

    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert!(mouse_sink::recorded().is_empty());
}

#[test]
fn a_zero_click_count_is_rejected_with_zero_injection() {
    reset_sinks();
    let error = synthesize_mouse(
        click_event(origin(), 0, Vec::new(), MouseButton::Left),
        deadline(1_000),
    )
    .expect_err("zero click count is rejected");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(mouse_sink::recorded().is_empty());
}

#[test]
fn a_click_count_beyond_the_maximum_is_rejected_with_zero_injection() {
    reset_sinks();
    let error = synthesize_mouse(
        click_event(
            origin(),
            MAX_MOUSE_CLICK_COUNT + 1,
            Vec::new(),
            MouseButton::Left,
        ),
        deadline(1_000),
    )
    .expect_err("out-of-bounds click count is rejected");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(mouse_sink::recorded().is_empty());
}

#[test]
fn an_invalid_point_is_rejected_with_zero_injection() {
    reset_sinks();
    let event = move_event(Point {
        x: f64::NAN,
        y: 0.0,
    });
    let error = synthesize_mouse(event, deadline(1_000)).expect_err("NaN point is rejected");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(mouse_sink::recorded().is_empty());
}

#[test]
fn a_multi_click_that_times_out_after_the_first_cycle_reports_cumulative_delivery() {
    reset_sinks();
    let short = Deadline::after(30).expect("bounded test deadline");

    let error = synthesize_mouse(
        click_event(origin(), 3, Vec::new(), MouseButton::Left),
        short,
    )
    .expect_err("three clicks cannot fit in the budget");

    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveredUnverified,
        "input landed, so the caller must not be told it is safe to repeat"
    );
    let delivered = error.details.expect("delivery evidence")["delivered_events"]
        .as_u64()
        .expect("delivered_events count");
    assert!(
        delivered >= 2,
        "the count must span the whole sequence, not reset per click; got {delivered}"
    );
}
