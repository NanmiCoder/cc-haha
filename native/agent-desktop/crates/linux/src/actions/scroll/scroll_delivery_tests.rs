use super::*;

#[test]
fn an_accepted_scroll_followed_by_no_bar_is_not_retry_safe() {
    let mut waiter = clock(10_000);
    let mut port = Fake::new(waiter.clone());
    port.toolkit = "Chromium";
    port.scroll_to_answer = true;
    port.bar = BarFound::Missing { container: true };
    let error = drive(&mut port, &mut waiter).expect_err("target never appeared");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(port.scroll_to_calls, 1);
    assert!(port.writes.is_empty());
}

#[test]
fn completed_bar_writes_that_do_not_reveal_the_target_are_not_retry_safe() {
    let mut waiter = clock(60_000);
    let mut port = Fake::new(waiter.clone());
    port.moves_on_write = false;
    let error = drive(&mut port, &mut waiter).expect_err("target stays offscreen");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert!(!port.writes.is_empty());
}

#[test]
fn unknown_visibility_with_valid_bounds_never_fabricates_delivery() {
    let mut waiter = clock(5_000);
    let mut port = Fake::new(waiter.clone());
    port.view.offscreen = None;
    let error = drive(&mut port, &mut waiter).expect_err("visibility is unknown");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(cause(&error), "target_visibility_unknown");
    assert_eq!(port.scroll_to_calls, 0);
    assert!(port.writes.is_empty());
}

#[test]
fn a_read_error_after_a_bar_write_preserves_uncertain_delivery() {
    let mut waiter = clock(5_000);
    let mut port = Fake::new(waiter.clone());
    port.observe_error = true;
    let error = drive(&mut port, &mut waiter).expect_err("read failed after write");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    assert_eq!(port.writes, [5526.0]);
}

#[test]
fn a_target_withdrawn_after_the_scroll_stays_an_error_for_the_scroll_command() {
    let mut waiter = clock(5_000);
    let mut port = Fake::new(waiter.clone());
    port.observe_stale = true;
    let error = drive(&mut port, &mut waiter).expect_err("the target is gone after the write");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
}

#[test]
fn a_handle_gone_stale_after_a_delivered_scroll_ends_the_pointer_scroll_for_a_new_resolution() {
    let mut waiter = clock(5_000);
    let mut port = Fake::new(waiter.clone());
    port.observe_stale = true;
    before_pointer(drive(&mut port, &mut waiter)).expect("the caller resolves its ref again");
    assert_eq!(port.writes, [5526.0]);
}

#[test]
fn a_handle_gone_before_any_write_is_still_refused_undelivered() {
    let mut waiter = clock(5_000);
    let mut port = Fake::new(waiter.clone());
    port.view_stale = true;
    let error = before_pointer(drive(&mut port, &mut waiter)).expect_err("nothing was scrolled");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(port.writes.is_empty());
}

#[test]
fn a_scroll_that_fails_before_the_first_pointer_event_leaves_the_gesture_undelivered() {
    let setups: [fn(&mut Fake); 2] = [
        |port| port.observe_error = true,
        |port| port.moves_on_write = false,
    ];
    for setup in setups {
        let mut waiter = clock(5_000);
        let mut port = Fake::new(waiter.clone());
        setup(&mut port);
        let error = before_pointer(drive(&mut port, &mut waiter)).expect_err("the scroll failed");
        assert!(!port.writes.is_empty());
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
}
