use super::{SCROLL_LABEL, ScrollPlan, axis_name, scroll_effect_verified, scroll_judged_for};
use crate::system::fixture::test_time::deadline;
use crate::tree::actions::resolve_actions;
use crate::tree::properties::ElementProperties;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};
use agent_desktop_core::{
    ActionStepOutcome, AdapterError, DeliveryDisposition, DeliverySemantics, Direction, ErrorCode,
    Rect, actions::capability,
};
use std::cell::Cell;

fn only_scroll_available_reads() -> Vec<(TreeProperty, PropertyOutcome)> {
    let flags = [
        TreeProperty::InvokeAvailable,
        TreeProperty::ToggleAvailable,
        TreeProperty::ExpandCollapseAvailable,
        TreeProperty::SelectionItemAvailable,
        TreeProperty::ValueAvailable,
        TreeProperty::RangeValueAvailable,
        TreeProperty::ScrollAvailable,
        TreeProperty::ScrollItemAvailable,
        TreeProperty::IsKeyboardFocusable,
    ];
    let mut reads: Vec<_> = flags
        .into_iter()
        .map(|property| {
            let on = property == TreeProperty::ScrollAvailable;
            (property, PropertyOutcome::Known(PropertyValue::Flag(on)))
        })
        .collect();
    reads.push((TreeProperty::LegacyDefaultAction, PropertyOutcome::Absent));
    reads
}

fn plan(amount: u32, axis_scrollable: bool) -> ScrollPlan {
    ScrollPlan {
        scroll_available: true,
        axis_scrollable,
        axis_name: "vertical",
        amount,
    }
}

#[test]
fn down_times_three_issues_three_vertical_small_increments() {
    let advertised = resolve_actions(&ElementProperties::from_reads(only_scroll_available_reads()));
    let known = advertised.known().expect("Known actions");
    assert!(known.iter().any(|action| action == capability::SCROLL));

    let calls = Cell::new(0u8);
    let mut scroll_once = || {
        calls.set(calls.get() + 1);
        Ok(())
    };
    let mut observe = || true;
    let steps = scroll_judged_for(
        deadline(5_000),
        plan(3, true),
        &mut scroll_once,
        &mut observe,
    )
    .expect("scroll");
    assert_eq!(calls.get(), 3);
    assert_eq!(steps[0].label(), SCROLL_LABEL);
    assert_eq!(steps[0].verified(), Some(true));
    assert!(matches!(steps[0].outcome, ActionStepOutcome::Succeeded));
    assert_eq!(axis_name(&Direction::Down), "vertical");
}

#[test]
fn unscrollable_axis_is_not_delivered_and_names_the_axis() {
    let calls = Cell::new(0u8);
    let mut scroll_once = || {
        calls.set(calls.get() + 1);
        Ok(())
    };
    let mut observe = || false;
    let error = scroll_judged_for(
        deadline(5_000),
        ScrollPlan {
            scroll_available: true,
            axis_scrollable: false,
            axis_name: "horizontal",
            amount: 1,
        },
        &mut scroll_once,
        &mut observe,
    )
    .expect_err("axis");
    assert_eq!(calls.get(), 0);
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(error.message.contains("horizontal"));
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(
        error.details.as_ref().and_then(|d| d.get("axis")),
        Some(&serde_json::json!("horizontal"))
    );
}

#[test]
fn percent_unavailable_falls_back_to_bounds_change() {
    let before = Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    };
    let after = Rect {
        x: 0.0,
        y: 4.0,
        width: 10.0,
        height: 10.0,
    };
    assert!(scroll_effect_verified(
        None,
        None,
        Some(before),
        Some(after)
    ));
    assert!(!scroll_effect_verified(
        None,
        None,
        Some(before),
        Some(before)
    ));
    assert!(scroll_effect_verified(Some(0.0), Some(10.0), None, None));
    assert!(!scroll_effect_verified(
        Some(5.0),
        Some(5.0),
        Some(before),
        Some(before)
    ));
}

#[test]
fn scroll_unavailable_is_not_delivered() {
    let mut scroll_once = || Ok(());
    let mut observe = || true;
    let error = scroll_judged_for(
        deadline(5_000),
        ScrollPlan {
            scroll_available: false,
            axis_scrollable: true,
            axis_name: "vertical",
            amount: 1,
        },
        &mut scroll_once,
        &mut observe,
    )
    .expect_err("unavailable");
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn mid_scroll_failure_is_delivered_unverified() {
    let calls = Cell::new(0u8);
    let mut scroll_once = || {
        let next = calls.get() + 1;
        calls.set(next);
        if next >= 2 {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "scroll invoke failed",
            ));
        }
        Ok(())
    };
    let mut observe = || false;
    let error = scroll_judged_for(
        deadline(5_000),
        plan(3, true),
        &mut scroll_once,
        &mut observe,
    )
    .expect_err("partial");
    assert_eq!(calls.get(), 2);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
}

/// A scroll that stops part-way is re-framed as a partial delivery, but the
/// reason it stopped is what the caller acts on: a deadline is retryable with
/// a longer budget and a refusing control is not. Stamping both `ACTION_FAILED`
/// erased that difference.
#[test]
fn a_partial_scroll_keeps_the_code_of_whatever_stopped_it() {
    let attempts = Cell::new(0u32);
    let error = scroll_judged_for(
        deadline(5_000),
        plan(3, true),
        &mut || {
            attempts.set(attempts.get() + 1);
            if attempts.get() == 1 {
                Ok(())
            } else {
                Err(AdapterError::new(ErrorCode::Timeout, "provider went away"))
            }
        },
        &mut || true,
    )
    .expect_err("the second step fails");

    assert_eq!(
        error.code,
        ErrorCode::Timeout,
        "the cause survives re-framing"
    );
    assert_eq!(
        error.disposition,
        DeliverySemantics::delivered_unverified(),
        "one step landed, so the caller must re-read before retrying"
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|d| d.get("completed_steps")),
        Some(&serde_json::json!(1))
    );
}
