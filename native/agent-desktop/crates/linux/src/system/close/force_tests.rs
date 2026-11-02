use std::time::Duration;

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use super::super::Request;
use super::super::fake::Fake;
use super::close;
use crate::system::close::close_plan::TERM_GRACE;
use crate::system::process::liveness::Liveness;

fn request() -> Request<'static> {
    Request {
        name: "Calculator",
        pid: 42,
        instance: Some("t"),
        force: true,
    }
}

#[test]
fn a_live_process_that_exits_on_term_gets_no_kill() {
    let mut world = Fake::new(Liveness::Alive);
    world.exits_on_term = true;
    assert!(close(&world, &request()).expect("closes"));
    assert_eq!(world.count("term"), 1);
    assert_eq!(world.count("kill"), 0);
}

#[test]
fn a_stopped_process_gets_kill_and_never_term() {
    let mut world = Fake::new(Liveness::Stopped);
    world.exits_on_kill = true;
    close(&world, &request()).expect("closes");
    assert_eq!(world.count("term"), 0);
    assert_eq!(world.count("kill"), 1);
}

#[test]
fn a_process_that_ignores_term_is_killed_after_the_grace() {
    let mut world = Fake::new(Liveness::Alive);
    world.exits_on_kill = true;
    close(&world, &request()).expect("closes");
    assert_eq!(world.count("term"), 1);
    assert_eq!(world.count("kill"), 1);
    assert!(world.clock.get() >= TERM_GRACE);
    assert!(world.clock.get() < TERM_GRACE + Duration::from_millis(200));
}

#[test]
fn the_grace_is_cut_to_half_of_a_short_budget() {
    let mut world = Fake::new(Liveness::Alive);
    world.budget = Duration::from_millis(1_000);
    world.exits_on_kill = true;
    close(&world, &request()).expect("closes");
    assert!(world.clock.get() <= Duration::from_millis(600));
}

#[test]
fn kill_is_sent_once_while_the_process_takes_time_to_leave() {
    let world = Fake::new(Liveness::Stopped);
    let error = close(&world, &request()).expect_err("never exits");
    assert_eq!(world.count("kill"), 1);
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}

#[test]
fn a_refused_signal_is_the_error_and_not_delivered_when_nothing_was_sent() {
    let world = Fake::new(Liveness::Alive);
    let refused = AdapterError::new(ErrorCode::ActionFailed, "refused")
        .with_disposition(DeliverySemantics::not_delivered());
    world.signal_outcomes.borrow_mut().push(Err(refused));
    let error = close(&world, &request()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn an_exhausted_budget_before_the_first_signal_sends_nothing() {
    let mut world = Fake::new(Liveness::Alive);
    world.budget = Duration::ZERO;
    let error = close(&world, &request()).expect_err("times out");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(world.count("term"), 0);
    assert_eq!(world.count("kill"), 0);
}

#[test]
fn an_already_gone_process_gets_no_signal() {
    let world = Fake::new(Liveness::Gone);
    close(&world, &request()).expect("benign");
    assert_eq!(world.count("term"), 0);
    assert_eq!(world.count("kill"), 0);
}

#[test]
fn force_never_sends_a_close_request() {
    let mut world = Fake::new(Liveness::Alive);
    world.exits_on_term = true;
    close(&world, &request()).expect("closes");
    assert_eq!(world.count("close"), 0);
    assert_eq!(world.count("toplevels"), 0);
}
