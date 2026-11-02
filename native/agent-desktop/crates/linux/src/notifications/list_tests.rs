use super::*;
use crate::notifications::fake::{DaemonFailure, FakeWorld, log, reading, spec};
use agent_desktop_core::Deadline;

fn deadline() -> Deadline {
    Deadline::after(1_000).expect("a deadline")
}

fn world_of(specs: &[crate::notifications::fake::Spec]) -> FakeWorld {
    FakeWorld::new(&log(), vec![reading(specs)])
}

#[test]
fn identical_entries_keep_two_indices() {
    let world = world_of(&[spec("Mail", "Same"), spec("Mail", "Same")]);
    let listed = list_in(&world, &NotificationFilter::default(), deadline()).expect("listed");
    assert_eq!(
        listed.iter().map(|info| info.index).collect::<Vec<_>>(),
        vec![1, 2]
    );
}

#[test]
fn a_filter_keeps_the_index_the_unfiltered_list_gave() {
    let world = world_of(&[spec("Mail", "a"), spec("Chat", "b"), spec("Files", "c")]);
    let filter = NotificationFilter {
        app: Some("chat".to_owned()),
        ..NotificationFilter::default()
    };
    let listed = list_in(&world, &filter, deadline()).expect("listed");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].index, 2);
}

#[test]
fn the_limit_applies_after_the_filter() {
    let world = world_of(&[spec("Mail", "a"), spec("Chat", "b"), spec("Chat", "c")]);
    let filter = NotificationFilter {
        app: Some("chat".to_owned()),
        limit: Some(1),
        ..NotificationFilter::default()
    };
    let listed = list_in(&world, &filter, deadline()).expect("listed");
    assert_eq!(
        listed.iter().map(|info| info.index).collect::<Vec<_>>(),
        vec![2]
    );
}

#[test]
fn the_text_filter_matches_title_body_and_app() {
    let world = world_of(&[spec("Mail", "Invoice").body("due"), spec("Chat", "hi")]);
    let filter = NotificationFilter {
        text: Some("DUE".to_owned()),
        ..NotificationFilter::default()
    };
    let listed = list_in(&world, &filter, deadline()).expect("listed");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].title, "Invoice");
}

#[test]
fn a_proven_container_without_entries_is_an_empty_list() {
    let world = world_of(&[]);
    assert!(
        list_in(&world, &NotificationFilter::default(), deadline())
            .expect("listed")
            .is_empty()
    );
}

#[test]
fn a_cut_short_read_is_an_error_and_never_a_prefix() {
    let mut read = reading(&[spec("Mail", "a")]);
    read.complete = false;
    let world = FakeWorld::new(&log(), vec![read]);
    assert!(list_in(&world, &NotificationFilter::default(), deadline()).is_err());
}

#[test]
fn only_the_message_list_container_is_read() {
    let log = log();
    let world = FakeWorld::new(&log, vec![reading(&[spec("Mail", "a")])]);
    list_in(&world, &NotificationFilter::default(), deadline()).expect("listed");
    assert!(log.borrow().iter().any(|line| line == "locate:MessageList"));
    assert!(
        !log.borrow()
            .iter()
            .any(|line| line.starts_with("click") || line == "open")
    );
}

#[test]
fn an_absent_notification_service_blocks_listing_before_the_shell_tree_is_read() {
    let log = log();
    let mut world = FakeWorld::new(&log, vec![reading(&[spec("Mail", "a")])]);
    world.faults.daemon = Some(DaemonFailure::Absent);
    let error = list_in(&world, &NotificationFilter::default(), deadline()).expect_err("error");
    assert_eq!(
        error.code,
        agent_desktop_core::ErrorCode::PlatformNotSupported
    );
    assert_eq!(error.details.expect("details")["daemon"], "absent");
    assert!(log.borrow().is_empty());
}

#[test]
fn an_unproven_notification_service_blocks_listing_with_its_own_error() {
    let log = log();
    let mut world = FakeWorld::new(&log, vec![reading(&[spec("Mail", "a")])]);
    world.faults.daemon = Some(DaemonFailure::Unsupported);
    let error = list_in(&world, &NotificationFilter::default(), deadline()).expect_err("error");
    assert_eq!(
        error.code,
        agent_desktop_core::ErrorCode::PlatformNotSupported
    );
    assert_eq!(error.details.expect("details")["daemon"], "unsupported");
    assert!(log.borrow().is_empty());
}

#[test]
fn an_entry_whose_labels_have_not_filled_in_yet_is_read_again() {
    let mut half = reading(&[spec("Mail", "hello")]);
    half.visits
        .iter_mut()
        .filter(|visit| visit.light.name == "hello")
        .for_each(|visit| visit.light.name.clear());
    let good = reading(&[spec("Mail", "hello")]);
    let world = FakeWorld::new(&log(), vec![half, good]).staged_by_reads();
    let listed = list_in(&world, &NotificationFilter::default(), deadline()).expect("listed");
    assert_eq!(listed[0].title, "hello");
}

#[test]
fn a_read_cut_short_by_a_vanishing_node_is_read_again() {
    let mut cut = reading(&[spec("Mail", "hello")]);
    cut.complete = false;
    let good = reading(&[spec("Mail", "hello")]);
    let world = FakeWorld::new(&log(), vec![cut, good]).staged_by_reads();
    let listed = list_in(&world, &NotificationFilter::default(), deadline()).expect("listed");
    assert_eq!(listed[0].title, "hello");
}

#[test]
fn an_entry_that_stays_unreadable_is_an_error_after_the_retries() {
    let mut half = reading(&[spec("Mail", "hello")]);
    half.visits
        .iter_mut()
        .filter(|visit| visit.light.name == "hello")
        .for_each(|visit| visit.light.name.clear());
    let world = FakeWorld::new(&log(), vec![half]);
    let error = list_in(&world, &NotificationFilter::default(), deadline()).expect_err("error");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Internal);
}
