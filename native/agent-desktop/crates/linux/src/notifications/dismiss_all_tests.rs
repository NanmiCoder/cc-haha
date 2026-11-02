use super::*;
use crate::notifications::fake::{FakeWorld, Spec, lease, log, reading, spec};
use crate::system::shell::search::Walk;
use agent_desktop_core::InteractionPolicy;

fn mixed() -> Vec<Spec> {
    vec![spec("Mail", "a1"), spec("Chat", "b1"), spec("Mail", "a2")]
}

fn request(app: Option<&str>, policy: InteractionPolicy) -> DismissAllNotificationsRequest<'_> {
    DismissAllNotificationsRequest {
        app_filter: app,
        policy,
    }
}

fn staged_removals() -> Vec<Walk> {
    vec![
        reading(&mixed()),
        reading(&[spec("Chat", "b1"), spec("Mail", "a2")]),
        reading(&[spec("Mail", "a2")]),
        reading(&[]),
    ]
}

#[test]
fn without_a_filter_every_entry_is_closed_through_its_own_control() {
    let log = log();
    let world = FakeWorld::new(&log, staged_removals());
    let (dismissed, failures) = dismiss_all_in(
        &world,
        request(None, InteractionPolicy::headed()),
        &lease(2_000),
    )
    .expect("cleared");
    assert_eq!(dismissed.len(), 3);
    assert!(failures.is_empty());
    assert_eq!(
        world.clicks(),
        ["/Mail:a1/close", "/Chat:b1/close", "/Mail:a2/close"]
    );
}

#[test]
fn the_footer_button_is_never_pressed_whatever_it_is_called() {
    let log = log();
    let mut full = reading(&mixed());
    full.visits
        .iter_mut()
        .filter(|visit| visit.light.element.path() == "/clear")
        .for_each(|visit| visit.light.name = "Clear all notifications".to_owned());
    let mut stages = staged_removals();
    stages[0] = full;
    let world = FakeWorld::new(&log, stages);
    dismiss_all_in(
        &world,
        request(None, InteractionPolicy::headed()),
        &lease(2_000),
    )
    .expect("cleared");
    assert!(!world.clicks().iter().any(|path| path == "/clear"));
}

#[test]
fn a_filter_closes_only_that_apps_entries_and_leaves_the_others() {
    let log = log();
    let stages = vec![
        reading(&mixed()),
        reading(&[spec("Chat", "b1"), spec("Mail", "a2")]),
        reading(&[spec("Chat", "b1")]),
    ];
    let world = FakeWorld::new(&log, stages);
    let (dismissed, failures) = dismiss_all_in(
        &world,
        request(Some("mail"), InteractionPolicy::headed()),
        &lease(2_000),
    )
    .expect("cleared");
    assert_eq!(dismissed.len(), 2);
    assert!(failures.is_empty());
    assert_eq!(world.clicks(), ["/Mail:a1/close", "/Mail:a2/close"]);
}

#[test]
fn an_ignored_close_reports_each_survivor() {
    let log = log();
    let world = FakeWorld::new(&log, vec![reading(&mixed())]);
    let (dismissed, failures) = dismiss_all_in(
        &world,
        request(None, InteractionPolicy::headed()),
        &lease(400),
    )
    .expect("outcome");
    assert!(dismissed.is_empty());
    assert_eq!(failures.len(), 3);
}

#[test]
fn a_notification_that_arrives_during_the_dismissal_is_not_a_failure() {
    let log = log();
    let world = FakeWorld::new(
        &log,
        vec![reading(&[spec("Mail", "a1")]), reading(&[spec("New", "n")])],
    );
    let (dismissed, failures) = dismiss_all_in(
        &world,
        request(None, InteractionPolicy::headed()),
        &lease(600),
    )
    .expect("outcome");
    assert_eq!(dismissed.len(), 1);
    assert!(failures.is_empty());
}

#[test]
fn a_bystander_that_leaves_with_a_target_is_recorded_against_it() {
    let log = log();
    let world = FakeWorld::new(
        &log,
        vec![reading(&mixed()), reading(&[spec("Chat", "b1")])],
    );
    let (_, failures) = dismiss_all_in(
        &world,
        request(Some("mail"), InteractionPolicy::headed()),
        &lease(600),
    )
    .expect("outcome");
    assert!(
        failures
            .iter()
            .any(|line| line.contains("other than the target"))
    );
}

#[test]
fn a_press_error_is_a_per_entry_failure_not_an_abort() {
    let log = log();
    let mut world = FakeWorld::new(&log, vec![reading(&mixed())]);
    world.faults.click = true;
    let (dismissed, failures) = dismiss_all_in(
        &world,
        request(Some("mail"), InteractionPolicy::headed()),
        &lease(600),
    )
    .expect("outcome");
    assert!(dismissed.is_empty());
    assert_eq!(failures.len(), 2);
}

#[test]
fn an_empty_list_is_cleared_without_opening_it() {
    let log = log();
    let world = FakeWorld::new(&log, vec![reading(&[])]);
    let (dismissed, failures) = dismiss_all_in(
        &world,
        request(None, InteractionPolicy::headed()),
        &lease(600),
    )
    .expect("cleared");
    assert!(dismissed.is_empty() && failures.is_empty());
    assert!(world.clicks().is_empty());
    assert!(!log.borrow().iter().any(|line| line == "open"));
}

#[test]
fn a_list_that_cannot_be_read_after_a_press_is_a_delivered_unverified_failure() {
    let log = log();
    let mut world = FakeWorld::new(&log, vec![reading(&mixed())]);
    world.faults.read_after_click = true;
    let error = dismiss_all_in(
        &world,
        request(None, InteractionPolicy::headed()),
        &lease(600),
    )
    .expect_err("unconfirmed");
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
}
