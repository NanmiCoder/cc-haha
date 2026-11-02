use super::*;
use crate::input::clipboard::test_nonce::test_nonce;

#[test]
fn clear_releases_the_selection_and_stops_a_live_recorded_owner() {
    let world = World::new("clear-live");
    let mut owner = sleeper();
    let ticks = start_ticks_of(owner.id()).expect("start time");
    write_record(&world, owner.id(), ticks, &test_nonce());
    let server = FakeServer::new(&[None], &[]);
    run_clear(&world, &server).expect("cleared");
    assert_eq!(server.released.get(), 1);
    assert!(!owner.wait().expect("the owner ends").success());
    assert!(world.record_names().is_empty());
}

#[test]
fn clear_deletes_a_stale_record_without_signalling_a_recycled_pid() {
    let world = World::new("clear-stale");
    let bystander = sleeper();
    let ticks = start_ticks_of(bystander.id()).expect("start time");
    write_record(
        &world,
        bystander.id(),
        ticks.wrapping_add(11),
        &test_nonce(),
    );
    let server = FakeServer::new(&[None], &[]);
    run_clear(&world, &server).expect("cleared");
    assert!(world.record_names().is_empty());
    assert!(
        alive(bystander.id()),
        "a stale record must not be signalled"
    );
    let mut bystander = bystander;
    terminate(Some(bystander.id()));
    let _ = bystander.wait();
}

#[test]
fn clear_with_another_client_re_owning_is_unresponsive_and_delivered_unverified() {
    let world = World::new("clear-reowned");
    let server = FakeServer::new(&[Some(9)], &[]);
    let error = run_clear(&world, &server).expect_err("re-owned");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}

#[test]
fn a_helper_that_exits_after_the_selection_changed_hands_is_uncertain() {
    let world = World::new("exits-changed");
    let helper = world.helper(EXITS);
    let server = FakeServer::new(&[Some(100), Some(200)], &[]);
    let error = run_set(&world, &helper, &server, &text("hello"), 3_000).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
}

#[test]
fn a_clear_whose_release_may_have_been_sent_is_uncertain_and_keeps_the_records() {
    let world = World::new("clear-unconfirmed");
    let mut owner = sleeper();
    let ticks = start_ticks_of(owner.id()).expect("start time");
    write_record(&world, owner.id(), ticks, &test_nonce());
    let server = FakeServer::new(&[None], &[]);
    *server.release_fault.borrow_mut() = Some(Fault::MutationUnconfirmed);
    let error = run_clear(&world, &server).expect_err("unconfirmed");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    assert_eq!(world.record_names().len(), 1);
    assert!(alive(owner.id()), "an unconfirmed release keeps the owner");
    terminate(Some(owner.id()));
    let _ = owner.wait();
}

#[test]
fn a_clear_whose_release_never_started_is_not_delivered() {
    let world = World::new("clear-cancelled");
    let server = FakeServer::new(&[None], &[]);
    *server.release_fault.borrow_mut() = Some(Fault::Timeout);
    let error = run_clear(&world, &server).expect_err("timeout");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}
