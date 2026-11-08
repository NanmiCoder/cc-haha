use super::*;
use crate::input::mouse::mouse_send::mouse_send_fake_sink as sink;
use crate::input::mouse::mouse_send::{MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE};
use agent_desktop_core::{Deadline, Point};

fn drag_params(duration_ms: Option<u64>, drop_delay_ms: Option<u64>) -> DragParams {
    DragParams {
        from: Point { x: 0.0, y: 0.0 },
        to: Point { x: 10.0, y: 10.0 },
        duration_ms,
        drop_delay_ms,
    }
}

fn long_deadline() -> Deadline {
    Deadline::after(5_000).expect("bounded test deadline")
}

fn base_params() -> DragParams {
    drag_params(None, None)
}

#[test]
fn drag_limits_reject_unbounded_work_and_accept_the_limits_themselves() {
    let too_long = DragParams {
        duration_ms: Some(MAX_DRAG_MS + 1),
        ..base_params()
    };
    let error = validate_drag(&too_long).expect_err("a duration past the limit is refused");
    assert_eq!(error.code, ErrorCode::InvalidArgs);

    let too_slow_to_release = DragParams {
        duration_ms: None,
        drop_delay_ms: Some(MAX_DROP_DELAY_MS + 1),
        ..base_params()
    };
    let error =
        validate_drag(&too_slow_to_release).expect_err("a drop delay past the limit is refused");
    assert_eq!(error.code, ErrorCode::InvalidArgs);

    let at_the_duration_limit = DragParams {
        duration_ms: Some(MAX_DRAG_MS),
        ..base_params()
    };
    assert!(validate_drag(&at_the_duration_limit).is_ok());

    let at_the_drop_delay_limit = DragParams {
        drop_delay_ms: Some(MAX_DROP_DELAY_MS),
        ..base_params()
    };
    assert!(validate_drag(&at_the_drop_delay_limit).is_ok());
}

#[test]
fn impossible_drag_deadline_fails_before_mouse_down() {
    sink::reset();
    let params = DragParams {
        duration_ms: Some(1),
        drop_delay_ms: Some(0),
        ..base_params()
    };

    let error = synthesize_drag(params, Deadline::after(1).expect("bounded deadline"))
        .expect_err("deadline too tight to complete the drag");

    assert_eq!(error.code, ErrorCode::Timeout);
    let details = error.details.expect("timeout carries preflight details");
    assert_eq!(details["physical_delivery_started"], false);
    assert!(
        sink::recorded().is_empty(),
        "an impossible deadline must not post mouse-down"
    );
}

/// Counts the moves posted while the button is down: everything between
/// the mouse-down and the release. Travel and dwell both post moves, so a
/// zero dwell is visible as the absence of the extra ones.
fn moves_while_button_held(events: &[crate::input::mouse::mouse_send::MouseInputEvent]) -> usize {
    let down = events
        .iter()
        .position(|event| event.flags == MOUSEEVENTF_LEFTDOWN);
    let up = events
        .iter()
        .position(|event| event.flags == MOUSEEVENTF_LEFTUP);
    match (down, up) {
        (Some(down), Some(up)) if up > down => events[down + 1..up]
            .iter()
            .filter(|event| event.flags & MOUSEEVENTF_MOVE != 0)
            .count(),
        _ => 0,
    }
}

#[test]
fn a_zero_drop_delay_posts_no_dwell_moves_while_a_nonzero_one_does() {
    sink::reset();
    synthesize_drag(drag_params(Some(0), Some(0)), long_deadline()).expect("drag succeeds");
    let without_dwell = moves_while_button_held(&sink::recorded());

    sink::reset();
    synthesize_drag(drag_params(Some(0), Some(64)), long_deadline()).expect("drag succeeds");
    let with_dwell = moves_while_button_held(&sink::recorded());

    assert!(
        with_dwell > without_dwell,
        "a dwell must post repeated moves over the destination; got {without_dwell} without and {with_dwell} with"
    );
}

#[test]
fn a_sub_tick_duration_still_posts_one_interpolated_move() {
    sink::reset();
    synthesize_drag(drag_params(Some(1), Some(0)), long_deadline()).expect("drag succeeds");

    assert_eq!(
        moves_while_button_held(&sink::recorded()),
        2,
        "one interpolated travel step plus the final move onto the destination"
    );
}

#[test]
fn a_successful_drag_posts_down_move_and_up_with_no_corrective_release() {
    sink::reset();
    let params = DragParams {
        duration_ms: Some(0),
        drop_delay_ms: Some(0),
        ..base_params()
    };

    synthesize_drag(params, Deadline::after(5_000).expect("bounded deadline"))
        .expect("a well-formed drag with an ample deadline succeeds");

    let recorded = sink::recorded();
    assert_eq!(
        recorded.get(1).map(|event| event.flags),
        Some(MOUSEEVENTF_LEFTDOWN),
        "the move to the origin is immediately followed by the button down"
    );
    assert!(
        recorded
            .iter()
            .any(|event| event.flags & MOUSEEVENTF_MOVE == MOUSEEVENTF_MOVE),
        "at least one move event steps toward the destination"
    );
    assert_eq!(
        recorded.last().map(|event| event.flags),
        Some(MOUSEEVENTF_LEFTUP),
        "the sequence ends with the release and nothing after it"
    );
    let down_count = recorded
        .iter()
        .filter(|event| event.flags == MOUSEEVENTF_LEFTDOWN)
        .count();
    let up_count = recorded
        .iter()
        .filter(|event| event.flags == MOUSEEVENTF_LEFTUP)
        .count();
    assert_eq!(down_count, 1, "no corrective mouse-down is ever posted");
    assert_eq!(
        up_count, 1,
        "a completed drag disarms the guard, so Drop posts no second release"
    );
}

#[test]
fn a_deadline_that_covers_only_one_pickup_delay_is_refused_before_the_button_lands() {
    sink::reset();
    let params = DragParams {
        from: Point { x: 0.0, y: 0.0 },
        to: Point { x: 10.0, y: 10.0 },
        duration_ms: Some(0),
        drop_delay_ms: Some(0),
    };
    let deadline = Deadline::after(PICKUP_DELAY_MS + 20).expect("bounded deadline");

    let error = synthesize_drag(params, deadline).expect_err("one pickup delay is not enough");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.details.expect("preflight detail")["physical_delivery_started"],
        false
    );
    assert!(sink::recorded().is_empty(), "nothing may be injected");
}
