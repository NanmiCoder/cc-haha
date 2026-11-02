use super::*;
use crate::notifications::fake::{DaemonFailure, FakeWorld, lease, log, reading, spec};
use agent_desktop_core::{ErrorCode, InteractionPolicy};

fn world(log: &crate::notifications::fake::Log) -> FakeWorld {
    FakeWorld::new(log, vec![reading(&[spec("Mail", "a")])])
}

#[test]
fn a_policy_that_does_not_move_the_pointer_is_refused() {
    for policy in [
        InteractionPolicy::headless(),
        InteractionPolicy::focus_fallback(),
    ] {
        let error = require_headed(policy).expect_err("refused");
        assert_eq!(error.code, ErrorCode::PolicyDenied);
    }
    assert!(require_headed(InteractionPolicy::headed()).is_ok());
}

#[test]
fn a_missing_notification_daemon_blocks_mutation_before_opening_the_list() {
    let log = log();
    let mut world = world(&log);
    world.faults.daemon = Some(DaemonFailure::Absent);
    let lease = lease(500);
    let error = Session::open(&world, InteractionPolicy::headed(), &lease)
        .err()
        .expect("error");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert!(log.borrow().is_empty());
}

#[test]
fn a_list_the_session_opened_is_closed_on_success() {
    let log = log();
    let world = world(&log);
    let lease = lease(500);
    let session = Session::open(&world, InteractionPolicy::headed(), &lease).expect("open");
    assert_eq!(session.finish(Ok(1)).expect("ok"), 1);
    assert!(!world.showing.get());
}

#[test]
fn a_list_the_session_opened_is_closed_on_error() {
    let log = log();
    let world = world(&log);
    let lease = lease(500);
    let session = Session::open(&world, InteractionPolicy::headed(), &lease).expect("open");
    let error = session
        .finish::<()>(Err(AdapterError::timeout("late")))
        .expect_err("error");
    assert!(!world.showing.get());
    assert_eq!(error.details.expect("details")["list_restore"], "closed");
}

#[test]
fn a_list_that_was_showing_is_adopted_and_left_open() {
    let log = log();
    let world = world(&log).adopted();
    let lease = lease(500);
    let session = Session::open(&world, InteractionPolicy::headed(), &lease).expect("open");
    session.finish(Ok(())).expect("ok");
    assert!(world.showing.get());
    assert!(!log.borrow().iter().any(|line| line == "close"));
}

#[test]
fn a_close_that_does_not_stick_turns_a_success_into_an_error_naming_it() {
    let log = log();
    let mut world = world(&log);
    world.faults.close_sticks = true;
    let lease = lease(500);
    let session = Session::open(&world, InteractionPolicy::headed(), &lease).expect("open");
    let error = session.finish(Ok(())).expect_err("unverified");
    assert_eq!(
        error.details.expect("details")["list_restore"],
        "unverified"
    );
}

#[test]
fn an_open_that_failed_after_showing_the_list_still_closes_it() {
    let log = log();
    let mut world = world(&log);
    world.faults.window_info = true;
    let lease = lease(500);
    let error = Session::open(&world, InteractionPolicy::headed(), &lease)
        .err()
        .expect("error");
    assert!(!world.showing.get());
    assert_eq!(error.details.expect("details")["list_restore"], "closed");
}

#[test]
fn an_adopted_list_stays_open_when_its_window_info_read_fails() {
    let log = log();
    let mut world = world(&log).adopted();
    world.faults.window_info = true;
    let lease = lease(500);
    let error = Session::open(&world, InteractionPolicy::headed(), &lease)
        .err()
        .expect("error");
    assert!(world.showing.get());
    assert!(!log.borrow().iter().any(|line| line == "close"));
    assert_eq!(error.details.expect("details")["list_restore"], "adopted");
}

#[test]
fn the_list_is_closed_even_when_the_command_spent_its_whole_budget() {
    let log = log();
    let world = world(&log);
    let lease = lease(5);
    let session = Session::open(&world, InteractionPolicy::headed(), &lease).expect("open");
    std::thread::sleep(std::time::Duration::from_millis(30));
    assert_eq!(session.finish(Ok(1)).expect("closed"), 1);
    assert!(!world.showing.get());
}

#[test]
fn an_open_that_fails_tells_the_agent_to_open_the_list_by_hand() {
    let log = log();
    let mut world = world(&log);
    world.faults.open = true;
    let lease = lease(500);
    let error = Session::open(&world, InteractionPolicy::headed(), &lease)
        .err()
        .expect("error");
    let suggestion = error.suggestion.expect("a suggestion");
    assert!(suggestion.contains("by hand"), "{suggestion}");
    assert!(suggestion.contains("already showing"), "{suggestion}");
}
