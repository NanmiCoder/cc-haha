use agent_desktop_core::{Action, DeliverySemantics, ErrorCode};

use super::*;
use crate::actions::chain::chain_delivery_outcome::DeliveryOutcome;
use crate::actions::chain::chain_observed::Observed;
use crate::actions::write::mutation::WriteReply;

fn facts(
    expandable: Option<bool>,
    expanded: Option<bool>,
    has_popup: Option<bool>,
) -> DisclosureFacts {
    DisclosureFacts {
        expandable,
        expanded,
        has_popup,
    }
}

#[test]
fn an_incomplete_state_read_is_refused_without_a_write() {
    for incomplete in [
        facts(None, Some(false), Some(false)),
        facts(Some(true), None, Some(false)),
    ] {
        let error = plan_disclosure(incomplete, &Action::Expand).expect_err("refused");
        assert_eq!(error.code, ErrorCode::ActionFailed);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
}

#[test]
fn a_leaf_is_never_invoked() {
    let error = plan_disclosure(
        facts(Some(false), Some(false), Some(false)),
        &Action::Expand,
    )
    .expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn a_collapsed_menu_button_is_not_a_leaf() {
    let flag = plan_disclosure(facts(Some(false), Some(false), Some(true)), &Action::Expand)
        .expect("planned");
    assert_eq!(flag, Flag::Off);
}

#[test]
fn an_expanded_node_without_the_expandable_bit_is_not_a_leaf() {
    let flag =
        plan_disclosure(facts(Some(false), Some(true), None), &Action::Collapse).expect("planned");
    assert_eq!(flag, Flag::On);
}

#[test]
fn expanding_an_expanded_node_is_satisfied_with_no_write() {
    let current = plan_disclosure(facts(Some(true), Some(true), Some(false)), &Action::Expand)
        .expect("planned");
    let mut writes = 0;
    let outcome = drive_to(
        true,
        current,
        || {
            writes += 1;
            Ok(WriteReply::Done)
        },
        || Flag::On,
    );
    assert_eq!(outcome.expect("satisfied"), DeliveryOutcome::Satisfied);
    assert_eq!(writes, 0);
}

#[test]
fn expanding_a_collapsed_node_writes_once_and_matches() {
    let mut writes = 0;
    let outcome = drive_to(
        true,
        Flag::Off,
        || {
            writes += 1;
            Ok(WriteReply::Done)
        },
        || Flag::On,
    );
    assert_eq!(
        outcome.expect("delivered"),
        DeliveryOutcome::Delivered(Observed::Matched)
    );
    assert_eq!(writes, 1);
}

#[test]
fn collapsing_that_leaves_the_node_expanded_is_unchanged() {
    let outcome = drive_to(false, Flag::On, || Ok(WriteReply::Done), || Flag::On);
    assert_eq!(
        outcome.expect("delivered"),
        DeliveryOutcome::Delivered(Observed::Unchanged)
    );
}
