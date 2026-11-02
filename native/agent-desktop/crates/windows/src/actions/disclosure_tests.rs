use super::{DisclosureInput, ExpandKind, disclosure_judged_for, disclosure_plan, invoke_allowed};
use crate::actions::chain::DeliveryOutcome;
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{ActionStepOutcome, DeliveryDisposition, ErrorCode, InteractionPolicy};
use std::cell::Cell;

fn input(
    want_expanded: bool,
    current: Option<ExpandKind>,
    pattern_ok: bool,
    invoke_ok: bool,
) -> DisclosureInput {
    DisclosureInput {
        want_expanded,
        current,
        pattern_ok,
        invoke_ok,
    }
}

#[test]
fn disclosure_plan_never_blindly_toggles_unknown_or_leaf() {
    assert_eq!(
        disclosure_plan(Some(ExpandKind::Expanded), true),
        (true, false, false)
    );
    assert_eq!(
        disclosure_plan(Some(ExpandKind::Collapsed), true),
        (false, false, true)
    );
    assert_eq!(disclosure_plan(None, true), (false, false, true));
    assert_eq!(
        disclosure_plan(Some(ExpandKind::LeafNode), true),
        (false, true, false)
    );
    assert!(!invoke_allowed(None, true));
    assert!(!invoke_allowed(Some(ExpandKind::LeafNode), true));
    assert!(invoke_allowed(Some(ExpandKind::Collapsed), true));
    assert!(!invoke_allowed(Some(ExpandKind::PartiallyExpanded), true));
}

#[test]
fn expand_collapsed_delivers_verified() {
    for invoke_ok in [true, false] {
        let pattern = Cell::new(0u8);
        let steps = disclosure_judged_for(
            deadline(5_000),
            InteractionPolicy::headless(),
            input(true, Some(ExpandKind::Collapsed), true, invoke_ok),
            || {
                pattern.set(pattern.get() + 1);
                Ok(DeliveryOutcome::DeliveredVerified)
            },
            || Ok(DeliveryOutcome::DeliveredVerified),
        )
        .expect("expand");
        assert_eq!(pattern.get(), 1, "invoke_ok = {invoke_ok}");
        assert_eq!(steps[0].label(), "ExpandCollapsePattern.Expand");
        assert_eq!(steps[0].verified(), Some(true));
    }
}

#[test]
fn expand_already_expanded_is_satisfied() {
    let pattern = Cell::new(0u8);
    let invoke = Cell::new(0u8);
    let steps = disclosure_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        input(true, Some(ExpandKind::Expanded), true, true),
        || {
            pattern.set(pattern.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
        || {
            invoke.set(invoke.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
    )
    .expect("satisfied");
    assert_eq!(pattern.get(), 0);
    assert_eq!(invoke.get(), 0);
    assert_eq!(steps[0].label(), "AlreadyInState");
    assert!(matches!(steps[0].outcome, ActionStepOutcome::Skipped));
    assert_eq!(steps[0].verified(), Some(true));
}

#[test]
fn expand_leaf_node_exhausts_without_pattern_or_invoke() {
    let pattern = Cell::new(0u8);
    let invoke = Cell::new(0u8);
    let error = disclosure_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        input(true, Some(ExpandKind::LeafNode), true, true),
        || {
            pattern.set(pattern.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
        || {
            invoke.set(invoke.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
    )
    .expect_err("leaf");
    assert_eq!(pattern.get(), 0);
    assert_eq!(invoke.get(), 0);
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn unknown_state_never_blind_fires_invoke() {
    let pattern = Cell::new(0u8);
    let invoke = Cell::new(0u8);
    let steps = disclosure_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        input(true, None, true, true),
        || {
            pattern.set(pattern.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
        || {
            invoke.set(invoke.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
    )
    .expect("pattern only");
    assert_eq!(pattern.get(), 1);
    assert_eq!(invoke.get(), 0);
    assert_eq!(steps[0].verified(), Some(true));
}

#[test]
fn invoke_fallback_only_when_known_opposite() {
    let invoke = Cell::new(0u8);
    let steps = disclosure_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        input(true, Some(ExpandKind::Collapsed), false, true),
        || Ok(DeliveryOutcome::DeliveredVerified),
        || {
            invoke.set(invoke.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
    )
    .expect("invoke");
    assert_eq!(invoke.get(), 1);
    assert_eq!(steps[1].label(), "InvokePattern.Invoke");
}

#[test]
fn collapse_expanded_delivers_verified() {
    let steps = disclosure_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        input(false, Some(ExpandKind::Expanded), true, false),
        || Ok(DeliveryOutcome::DeliveredVerified),
        || Ok(DeliveryOutcome::NotDelivered),
    )
    .expect("collapse");
    assert_eq!(steps[0].label(), "ExpandCollapsePattern.Collapse");
    assert_eq!(steps[0].verified(), Some(true));
}

#[test]
fn zero_budget_disclosure_times_out() {
    let error = disclosure_judged_for(
        deadline(0),
        InteractionPolicy::headless(),
        input(true, Some(ExpandKind::Collapsed), true, false),
        || Ok(DeliveryOutcome::DeliveredVerified),
        || Ok(DeliveryOutcome::NotDelivered),
    )
    .expect_err("timeout");
    assert_eq!(error.code, ErrorCode::Timeout);
}
