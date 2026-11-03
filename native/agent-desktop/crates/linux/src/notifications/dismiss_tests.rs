use super::*;
use crate::notifications::fake::{FakeWorld, Spec, lease, log, reading, spec};
use agent_desktop_core::{ErrorCode, InteractionPolicy, NotificationIdentity};

fn three() -> Vec<Spec> {
    vec![spec("Mail", "a"), spec("Chat", "b"), spec("Files", "c")]
}

fn identity(app: &str, title: &str) -> NotificationIdentity {
    NotificationIdentity {
        expected_app: Some(app.to_owned()),
        expected_title: Some(title.to_owned()),
    }
}

fn request<'a>(
    index: usize,
    identity: &'a NotificationIdentity,
    policy: InteractionPolicy,
) -> DismissNotificationRequest<'a> {
    DismissNotificationRequest {
        index,
        app_filter: None,
        identity,
        policy,
    }
}

fn run(
    world: FakeWorld,
    identity: &NotificationIdentity,
) -> Result<NotificationInfo, AdapterError> {
    dismiss_in(
        &world,
        request(2, identity, InteractionPolicy::headed()),
        &lease(600),
    )
}

fn world_clicks(log: &crate::notifications::fake::Log) -> Vec<String> {
    log.borrow()
        .iter()
        .filter_map(|line| line.strip_prefix("click:").map(str::to_owned))
        .collect()
}

#[test]
fn the_close_button_of_the_target_is_clicked_and_nothing_else() {
    let log = log();
    let stages = vec![
        reading(&three()),
        reading(&[spec("Mail", "a"), spec("Files", "c")]),
    ];
    let world = FakeWorld::new(&log, stages);
    let done = run(world, &identity("Chat", "b")).expect("dismissed");
    assert_eq!(done.title, "b");
    assert_eq!(world_clicks(&log), vec!["/Chat:b/close"]);
}

#[test]
fn a_mismatched_identity_clicks_nothing() {
    let log = log();
    let world = FakeWorld::new(&log, vec![reading(&three())]);
    let error = run(world, &identity("Mail", "a")).expect_err("moved");
    assert_eq!(error.code, ErrorCode::NotificationNotFound);
    assert!(!log.borrow().iter().any(|line| line.starts_with("click")));
}

#[test]
fn a_reflow_between_the_reads_is_refused_before_the_click() {
    let log = log();
    let moved = vec![spec("New", "n"), spec("Mail", "a"), spec("Chat", "b")];
    let world = FakeWorld::new(&log, vec![reading(&three()), reading(&moved)]).staged_by_reads();
    let error = run(world, &NotificationIdentity::default()).expect_err("moved");
    assert_eq!(error.code, ErrorCode::NotificationNotFound);
    assert!(!log.borrow().iter().any(|line| line.starts_with("click")));
}

#[test]
fn a_different_entry_leaving_with_the_target_fails_the_call() {
    let log = log();
    let stages = vec![reading(&three()), reading(&[spec("Mail", "a")])];
    let world = FakeWorld::new(&log, stages);
    let error = run(world, &identity("Chat", "b")).expect_err("bystander");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(error.message.contains("other than the target"));
}

#[test]
fn a_different_entry_leaving_instead_of_the_target_fails_the_call() {
    let log = log();
    let stages = vec![
        reading(&three()),
        reading(&[spec("Chat", "b"), spec("Files", "c")]),
    ];
    let world = FakeWorld::new(&log, stages);
    let error = run(world, &identity("Chat", "b")).expect_err("bystander");
    assert!(error.message.contains("other than the target"));
}

#[test]
fn two_identical_entries_are_told_apart_by_their_object() {
    let before = || vec![spec("Chat", "x"), spec("Mail", "x"), spec("Mail", "x")];
    let kept_twin = FakeWorld::new(
        &log(),
        vec![
            reading(&before()),
            reading(&[spec("Chat", "x"), spec("Mail", "x").object("Mail:x#2")]),
        ],
    );
    assert!(run(kept_twin, &identity("Mail", "x")).is_ok());

    let wrong_twin_left = FakeWorld::new(
        &log(),
        vec![
            reading(&before()),
            reading(&[spec("Chat", "x"), spec("Mail", "x")]),
        ],
    );
    let error = run(wrong_twin_left, &identity("Mail", "x")).expect_err("the target stayed");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn a_header_button_that_only_expands_is_told_by_its_effect_and_the_next_is_pressed() {
    let log = log();
    let world = FakeWorld::new(
        &log,
        vec![
            reading(&three()),
            reading(&[
                spec("Mail", "a"),
                spec("Chat", "b").expanded(),
                spec("Files", "c"),
            ]),
            reading(&[spec("Mail", "a"), spec("Files", "c")]),
        ],
    );
    let done = dismiss_in(
        &world,
        request(2, &identity("Chat", "b"), InteractionPolicy::headed()),
        &lease(6_000),
    )
    .expect("the second header button closed it");
    assert_eq!(done.title, "b");
    assert_eq!(world_clicks(&log), vec!["/Chat:b/close", "/Chat:b/expand"]);
}

#[test]
fn a_click_the_shell_ignored_is_an_unverified_failure() {
    let log = log();
    let world = FakeWorld::new(&log, vec![reading(&three())]);
    let error = run(world, &identity("Chat", "b")).expect_err("survived");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn a_headless_policy_is_refused_with_no_event() {
    let log = log();
    let world = FakeWorld::new(&log, vec![reading(&three())]);
    let none = NotificationIdentity::default();
    let error = dismiss_in(
        &world,
        request(2, &none, InteractionPolicy::headless()),
        &lease(600),
    )
    .expect_err("denied");
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert!(log.borrow().is_empty());
}

#[test]
fn a_click_error_is_returned_and_the_list_is_still_restored() {
    let log = log();
    let mut world = FakeWorld::new(&log, vec![reading(&three())]);
    world.faults.click = true;
    assert!(run(world, &identity("Chat", "b")).is_err());
    assert!(log.borrow().iter().any(|line| line == "close"));
}

#[test]
fn an_entry_that_has_gone_is_not_found_without_opening_the_list() {
    let log = log();
    let world = FakeWorld::new(&log, vec![reading(&[])]);
    let error = run(world, &identity("Chat", "b")).expect_err("gone");
    assert_eq!(error.code, ErrorCode::NotificationNotFound);
    assert!(!log.borrow().iter().any(|line| line == "open"));
}

#[test]
fn a_list_that_cannot_be_read_after_the_click_is_a_delivered_unverified_failure() {
    let log = log();
    let mut world = FakeWorld::new(&log, vec![reading(&three())]);
    world.faults.read_after_click = true;
    let error = run(world, &identity("Chat", "b")).expect_err("unconfirmed");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
    assert!(error.platform_detail.is_some());
}
