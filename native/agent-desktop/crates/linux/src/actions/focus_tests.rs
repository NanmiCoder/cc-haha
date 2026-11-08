use std::cell::Cell;

use super::*;
use crate::actions::chain::chain_observed::Observed;

struct Scene {
    before: Option<bool>,
    reply: Result<WriteReply, AdapterError>,
    after: Option<bool>,
}

fn unfocused(reply: Result<WriteReply, AdapterError>, after: Option<bool>) -> Scene {
    Scene {
        before: Some(false),
        reply,
        after,
    }
}

fn judged(policy: InteractionPolicy, scene: Scene) -> (Result<DeliveryOutcome, AdapterError>, u32) {
    let writes = Cell::new(0);
    let outcome = focus_policy_gate(policy).and_then(|()| {
        judge_focus(
            scene.before,
            || {
                writes.set(writes.get() + 1);
                scene.reply
            },
            || scene.after,
        )
    });
    (outcome, writes.get())
}

#[test]
fn headless_focus_is_denied_with_a_foreground_effect_and_no_write() {
    let scene = unfocused(Ok(WriteReply::Done), Some(true));
    let (outcome, writes) = judged(InteractionPolicy::headless(), scene);
    let error = outcome.expect_err("denied");
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(
        error.details.expect("details")["foreground_effect"],
        serde_json::json!(true)
    );
    assert_eq!(writes, 0);
}

#[test]
fn cursor_only_policy_does_not_allow_focus() {
    let policy = InteractionPolicy {
        allow_focus_steal: false,
        allow_cursor_move: true,
    };
    let scene = unfocused(Ok(WriteReply::Done), Some(true));
    let (outcome, writes) = judged(policy, scene);
    assert_eq!(outcome.expect_err("denied").code, ErrorCode::PolicyDenied);
    assert_eq!(writes, 0);
}

#[test]
fn an_element_that_already_holds_focus_is_satisfied_without_a_grab() {
    let scene = Scene {
        before: Some(true),
        reply: Ok(WriteReply::Absent),
        after: Some(true),
    };
    let (outcome, writes) = judged(InteractionPolicy::headed(), scene);
    assert_eq!(outcome.expect("satisfied"), DeliveryOutcome::Satisfied);
    assert_eq!(writes, 0);
}

#[test]
fn an_unreadable_focus_state_before_the_grab_does_not_count_as_focus() {
    let scene = Scene {
        before: None,
        reply: Ok(WriteReply::Done),
        after: Some(true),
    };
    let (outcome, writes) = judged(InteractionPolicy::headed(), scene);
    assert_eq!(
        outcome.expect("delivered"),
        DeliveryOutcome::Delivered(Observed::Matched)
    );
    assert_eq!(writes, 1);
}

#[test]
fn a_grab_the_application_rejects_names_the_rejection_and_points_at_focus_window() {
    let scene = unfocused(Ok(WriteReply::Absent), Some(false));
    let (outcome, writes) = judged(InteractionPolicy::headed(), scene);
    let error = outcome.expect_err("rejected");
    assert_eq!(writes, 1);
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(
        error.details.expect("details")["cause"],
        serde_json::json!("grab_focus_rejected")
    );
    assert!(error.message.contains("GrabFocus"), "{}", error.message);
    let suggestion = error.suggestion.expect("a suggestion");
    assert!(suggestion.contains("focus-window"), "{suggestion}");
    assert!(!suggestion.contains("advertising"), "{suggestion}");
}

#[test]
fn an_accepted_grab_that_reads_back_focused_is_matched() {
    let scene = unfocused(Ok(WriteReply::Done), Some(true));
    let (outcome, _) = judged(InteractionPolicy::headed(), scene);
    assert_eq!(
        outcome.expect("delivered"),
        DeliveryOutcome::Delivered(Observed::Matched)
    );
}

#[test]
fn an_accepted_grab_that_leaves_the_node_unfocused_is_unchanged() {
    let scene = unfocused(Ok(WriteReply::Done), Some(false));
    let (outcome, _) = judged(InteractionPolicy::headed(), scene);
    assert_eq!(
        outcome.expect("delivered"),
        DeliveryOutcome::Delivered(Observed::Unchanged)
    );
}

#[test]
fn an_accepted_grab_whose_state_cannot_be_read_is_unread() {
    let scene = unfocused(Ok(WriteReply::Done), None);
    let (outcome, _) = judged(InteractionPolicy::headed(), scene);
    assert_eq!(
        outcome.expect("delivered"),
        DeliveryOutcome::Delivered(Observed::Unread)
    );
}

#[test]
fn an_error_of_the_grab_call_is_passed_on_untouched() {
    let sent = AdapterError::timeout("late").with_disposition(DeliverySemantics::uncertain());
    let (outcome, _) = judged(
        InteractionPolicy::headed(),
        unfocused(Err(sent), Some(true)),
    );
    let error = outcome.expect_err("timeout");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
}

#[test]
fn focus_that_drops_on_the_second_read_is_not_verified() {
    assert_eq!(corroborated(Some(true), Some(false)), Some(false));
}

#[test]
fn focus_held_across_two_reads_is_verified() {
    assert_eq!(corroborated(Some(true), Some(true)), Some(true));
}

#[test]
fn focus_not_seen_on_the_first_read_is_not_re_read_into_a_match() {
    assert_eq!(corroborated(Some(false), Some(true)), Some(false));
    assert_eq!(corroborated(None, Some(true)), None);
}

#[test]
fn a_failed_second_read_leaves_focus_unproven() {
    assert_eq!(corroborated(Some(true), None), None);
}
