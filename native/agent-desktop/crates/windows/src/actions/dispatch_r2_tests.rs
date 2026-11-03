use super::{ClickAvailability, click_chain_judged_for};
use crate::actions::chain::DeliveryOutcome;
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{ActionStepOutcome, InteractionPolicy};
use std::cell::Cell;

#[test]
fn r2_invoke_advertisement_reaches_click_rung() {
    let invoke = Cell::new(0u8);
    let legacy = Cell::new(0u8);
    let steps = click_chain_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        ClickAvailability {
            invoke_available: true,
            legacy_available: false,
        },
        || {
            invoke.set(invoke.get() + 1);
            Ok(DeliveryOutcome::DeliveredUnverified)
        },
        || {
            legacy.set(legacy.get() + 1);
            Ok(DeliveryOutcome::DeliveredUnverified)
        },
    )
    .expect("invoke rung");
    assert_eq!(invoke.get(), 1);
    assert_eq!(legacy.get(), 0);
    assert!(matches!(steps[0].outcome, ActionStepOutcome::Succeeded));
}

#[test]
fn r2_legacy_advertisement_reaches_legacy_rung() {
    let invoke = Cell::new(0u8);
    let legacy = Cell::new(0u8);
    let steps = click_chain_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        ClickAvailability {
            invoke_available: false,
            legacy_available: true,
        },
        || {
            invoke.set(invoke.get() + 1);
            Ok(DeliveryOutcome::DeliveredUnverified)
        },
        || {
            legacy.set(legacy.get() + 1);
            Ok(DeliveryOutcome::DeliveredUnverified)
        },
    )
    .expect("legacy rung");
    assert_eq!(invoke.get(), 0);
    assert_eq!(legacy.get(), 1);
    assert_eq!(steps[1].label(), "LegacyIAccessible.DoDefaultAction");
}
