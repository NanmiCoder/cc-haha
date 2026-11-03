use super::*;
use crate::notifications::fake::{FakeSignals, FakeWorld, Log, lease, log, reading, spec};
use crate::notifications::signal::Signal;
use crate::system::shell::search::Walk;
use agent_desktop_core::{ErrorCode, InteractionPolicy, NotificationIdentity};

fn identity() -> NotificationIdentity {
    NotificationIdentity {
        expected_app: Some("Mail".to_owned()),
        expected_title: Some("a".to_owned()),
    }
}

fn request<'a>(
    identity: &'a NotificationIdentity,
    name: &'a str,
    policy: InteractionPolicy,
) -> NotificationActionRequest<'a> {
    NotificationActionRequest {
        index: 1,
        identity,
        action_name: name,
        policy,
    }
}

fn entry(expanded: bool) -> Walk {
    let base = spec("Mail", "a").actions(&["Run A", "Run B"]);
    reading(&[
        if expanded { base.expanded() } else { base },
        spec("Chat", "z"),
    ])
}

fn gone() -> Walk {
    reading(&[spec("Chat", "z")])
}

fn signals(log: &Log, seen: Vec<Signal>) -> FakeSignals {
    FakeSignals {
        log: std::rc::Rc::clone(log),
        signals: seen,
        fails: false,
    }
}

fn go(world: &FakeWorld, source: &FakeSignals, name: &str) -> Result<ActionResult, AdapterError> {
    let who = identity();
    action_in(
        world,
        source,
        request(&who, name, InteractionPolicy::headed()),
        &lease(600),
    )
}

fn evidence_of(result: &ActionResult) -> String {
    result.details.as_ref().expect("details")["evidence"]
        .as_str()
        .expect("text")
        .to_owned()
}

#[test]
fn it_expands_then_clicks_the_named_button() {
    let log = log();
    let world = FakeWorld::new(&log, vec![entry(false), entry(true), gone()]);
    let source = signals(&log, vec![Signal::ActionInvoked(7), Signal::Closed(7)]);
    let result = go(&world, &source, "run b").expect("delivered");
    assert_eq!(world.clicks(), vec!["/Mail:a/expand", "/Mail:a/act/Run B"]);
    assert_eq!(result.action, "run b");
    assert_eq!(evidence_of(&result), "action_invoked");
}

#[test]
fn an_entry_that_is_already_expanded_is_not_expanded_again() {
    let log = log();
    let world = FakeWorld::new(&log, vec![entry(true), gone()]);
    go(&world, &signals(&log, Vec::new()), "Run A").expect("delivered");
    assert_eq!(world.clicks(), vec!["/Mail:a/act/Run A"]);
}

#[test]
fn the_subscription_is_made_before_the_action_click() {
    let log = log();
    let world = FakeWorld::new(&log, vec![entry(false), entry(true), gone()]);
    go(&world, &signals(&log, Vec::new()), "Run B").expect("delivered");
    let lines = log.borrow().clone();
    let subscribed = lines
        .iter()
        .position(|line| line == "subscribe")
        .expect("subscribed");
    let acted = lines
        .iter()
        .position(|line| line == "click:/Mail:a/act/Run B")
        .expect("clicked");
    assert!(subscribed < acted);
}

#[test]
fn an_unknown_label_lists_the_available_ones_and_clicks_nothing() {
    let log = log();
    let world = FakeWorld::new(&log, vec![entry(false)]);
    let error = go(&world, &signals(&log, Vec::new()), "Nope").expect_err("unsupported");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(
        error.details.expect("details")["available_actions"],
        serde_json::json!(["Run A", "Run B"])
    );
    assert!(world.clicks().is_empty());
    assert!(!log.borrow().iter().any(|line| line == "subscribe"));
}

#[test]
fn a_missing_signal_is_delivered_with_the_list_copy_as_evidence() {
    let log = log();
    let world = FakeWorld::new(&log, vec![entry(true), gone()]);
    let result = go(&world, &signals(&log, Vec::new()), "Run A").expect("delivered");
    assert_eq!(evidence_of(&result), "entry_removed");
    assert_eq!(
        result.disposition(),
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn a_subscription_that_could_not_be_made_does_not_fail_the_click() {
    let log = log();
    let world = FakeWorld::new(&log, vec![entry(true), gone()]);
    let mut source = signals(&log, Vec::new());
    source.fails = true;
    let result = go(&world, &source, "Run A").expect("delivered");
    assert_eq!(evidence_of(&result), "entry_removed");
}

#[test]
fn a_foreign_second_signal_ends_the_signal_claim() {
    let log = log();
    let world = FakeWorld::new(&log, vec![entry(true), gone()]);
    let source = signals(
        &log,
        vec![Signal::ActionInvoked(7), Signal::ActionInvoked(9)],
    );
    let result = go(&world, &source, "Run A").expect("delivered");
    assert_eq!(evidence_of(&result), "entry_removed");
}

#[test]
fn a_signal_while_the_entry_is_still_listed_does_not_claim_the_effect() {
    let log = log();
    let world = FakeWorld::new(&log, vec![entry(true)]);
    let source = signals(&log, vec![Signal::ActionInvoked(7)]);
    let error = go(&world, &source, "Run A").expect_err("no proof");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
    assert!(error.message.contains("stayed in the message list"));
}

#[test]
fn an_entry_that_moved_is_not_acted_on() {
    let log = log();
    let moved = reading(&[
        spec("New", "n"),
        spec("Mail", "a").actions(&["Run A"]).expanded(),
    ]);
    let world = FakeWorld::new(&log, vec![entry(true), moved]).staged_by_reads();
    let error = go(&world, &signals(&log, Vec::new()), "Run A").expect_err("moved");
    assert_eq!(error.code, ErrorCode::NotificationNotFound);
    assert!(world.clicks().is_empty());
}

#[test]
fn the_result_is_never_verified() {
    let log = log();
    let world = FakeWorld::new(&log, vec![entry(true), gone()]);
    let source = signals(&log, vec![Signal::ActionInvoked(1), Signal::Closed(1)]);
    let result = go(&world, &source, "Run A").expect("delivered");
    assert_eq!(
        result.disposition(),
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn a_list_that_cannot_be_read_after_the_click_is_a_delivered_unverified_failure() {
    let log = log();
    let mut world = FakeWorld::new(&log, vec![entry(true), gone()]);
    world.faults.read_after_click = true;
    let error = go(&world, &signals(&log, Vec::new()), "Run A").expect_err("unconfirmed");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn an_expand_control_that_removed_the_entry_is_reported_as_what_it_did() {
    let log = log();
    let world = FakeWorld::new(&log, vec![entry(false), gone()]);
    let error = go(&world, &signals(&log, Vec::new()), "Run B").expect_err("removed");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(error.message.contains("removed the notification instead"));
    assert_eq!(world.clicks(), vec!["/Mail:a/expand"]);
}
