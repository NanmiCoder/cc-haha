use super::{
    CheckUncheckPlan, ToggleAvailability, ToggleKind, check_uncheck_judged_for, toggle_judged_for,
};
use crate::actions::chain::DeliveryOutcome;
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{ActionStepOutcome, ErrorCode, InteractionPolicy};
use std::cell::Cell;

#[test]
fn toggle_change_observed_is_verified() {
    let toggle = Cell::new(0u8);
    let steps = toggle_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        ToggleAvailability {
            toggle_ok: true,
            invoke_ok: false,
        },
        || {
            toggle.set(toggle.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
        || Ok(DeliveryOutcome::NotDelivered),
    )
    .expect("toggle");
    assert_eq!(toggle.get(), 1);
    assert_eq!(steps[0].label(), "TogglePattern.Toggle");
    assert!(matches!(steps[0].outcome, ActionStepOutcome::Succeeded));
    assert_eq!(steps[0].verified(), Some(true));
}

#[test]
fn toggle_no_change_is_unverified() {
    let steps = toggle_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        ToggleAvailability {
            toggle_ok: true,
            invoke_ok: false,
        },
        || Ok(DeliveryOutcome::DeliveredUnverified),
        || Ok(DeliveryOutcome::NotDelivered),
    )
    .expect("toggle");
    assert_eq!(steps[0].verified(), Some(false));
}

#[test]
fn toggle_absent_falls_to_invoke() {
    let toggle = Cell::new(0u8);
    let invoke = Cell::new(0u8);
    let steps = toggle_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        ToggleAvailability {
            toggle_ok: false,
            invoke_ok: true,
        },
        || {
            toggle.set(toggle.get() + 1);
            Ok(DeliveryOutcome::DeliveredVerified)
        },
        || {
            invoke.set(invoke.get() + 1);
            Ok(DeliveryOutcome::DeliveredUnverified)
        },
    )
    .expect("invoke fallback");
    assert_eq!(toggle.get(), 0);
    assert_eq!(invoke.get(), 1);
    assert_eq!(steps[1].label(), "InvokePattern.Invoke");
    assert_eq!(steps[1].verified(), Some(false));
}

#[test]
fn check_from_off_toggles_once() {
    let toggles = Cell::new(0u8);
    let state = Cell::new(Some(ToggleKind::Off));
    let steps = check_uncheck_judged_for(
        deadline(5_000),
        CheckUncheckPlan {
            want_checked: true,
            toggle_ok: true,
            invoke_ok: false,
        },
        || state.get(),
        || {
            toggles.set(toggles.get() + 1);
            state.set(Some(ToggleKind::On));
            Ok(true)
        },
        || Ok(false),
    )
    .expect("check");
    assert_eq!(toggles.get(), 1);
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].verified(), Some(true));
}

#[test]
fn check_from_indeterminate_toggles_twice() {
    let toggles = Cell::new(0u8);
    let state = Cell::new(Some(ToggleKind::Indeterminate));
    let steps = check_uncheck_judged_for(
        deadline(5_000),
        CheckUncheckPlan {
            want_checked: true,
            toggle_ok: true,
            invoke_ok: false,
        },
        || state.get(),
        || {
            let next = match state.get() {
                Some(ToggleKind::Indeterminate) => ToggleKind::Off,
                Some(ToggleKind::Off) => ToggleKind::On,
                other => other.unwrap_or(ToggleKind::On),
            };
            toggles.set(toggles.get() + 1);
            state.set(Some(next));
            Ok(true)
        },
        || Ok(false),
    )
    .expect("tri-state");
    assert_eq!(toggles.get(), 2);
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[1].verified(), Some(true));
}

#[test]
fn check_already_on_skips_without_invoke() {
    let toggles = Cell::new(0u8);
    let invokes = Cell::new(0u8);
    let steps = check_uncheck_judged_for(
        deadline(5_000),
        CheckUncheckPlan {
            want_checked: true,
            toggle_ok: true,
            invoke_ok: true,
        },
        || Some(ToggleKind::On),
        || {
            toggles.set(toggles.get() + 1);
            Ok(true)
        },
        || {
            invokes.set(invokes.get() + 1);
            Ok(true)
        },
    )
    .expect("already");
    assert_eq!(toggles.get(), 0);
    assert_eq!(invokes.get(), 0);
    assert_eq!(steps[0].label(), "AlreadyInState");
    assert!(matches!(steps[0].outcome, ActionStepOutcome::Skipped));
    assert_eq!(steps[0].verified(), Some(true));
}

#[test]
fn uncheck_already_off_skips_without_invoke() {
    let toggles = Cell::new(0u8);
    let steps = check_uncheck_judged_for(
        deadline(5_000),
        CheckUncheckPlan {
            want_checked: false,
            toggle_ok: true,
            invoke_ok: true,
        },
        || Some(ToggleKind::Off),
        || {
            toggles.set(toggles.get() + 1);
            Ok(true)
        },
        || Ok(true),
    )
    .expect("already");
    assert_eq!(toggles.get(), 0);
    assert_eq!(steps[0].verified(), Some(true));
}

#[test]
fn zero_budget_check_times_out_without_sleeping_past_deadline() {
    let toggles = Cell::new(0u8);
    let error = check_uncheck_judged_for(
        deadline(0),
        CheckUncheckPlan {
            want_checked: true,
            toggle_ok: true,
            invoke_ok: false,
        },
        || Some(ToggleKind::Off),
        || {
            toggles.set(toggles.get() + 1);
            Ok(true)
        },
        || Ok(false),
    )
    .expect_err("timeout");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(toggles.get(), 0);
}

/// A provider that reports the same state after a delivered toggle is
/// ambiguous: the toggle may have landed unseen. Firing again on that
/// ambiguity is the one move that can leave the control back at its starting
/// state while every step claims delivery, so the run stops at one toggle and
/// hands the caller an unverified delivery to re-read.
#[test]
fn check_does_not_refire_a_toggle_the_provider_never_showed_moving() {
    let toggles = Cell::new(0u8);
    let invokes = Cell::new(0u8);
    let steps = check_uncheck_judged_for(
        deadline(5_000),
        CheckUncheckPlan {
            want_checked: true,
            toggle_ok: true,
            invoke_ok: true,
        },
        || Some(ToggleKind::Off),
        || {
            toggles.set(toggles.get() + 1);
            Ok(true)
        },
        || {
            invokes.set(invokes.get() + 1);
            Ok(true)
        },
    )
    .expect("delivered unverified");
    assert_eq!(toggles.get(), 1, "a second toggle would undo the first");
    assert_eq!(invokes.get(), 0);
    assert!(steps.iter().all(|step| step.verified() == Some(false)));
}
