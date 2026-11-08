use super::{ClickAvailability, click_chain_judged_for};
use crate::actions::chain::DeliveryOutcome;
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{ActionStepOutcome, DeliveryDisposition, ErrorCode, InteractionPolicy};
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
            invoke_requires_headed: false,
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
            invoke_requires_headed: false,
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

#[test]
fn winforms_headless_click_uses_only_legacy_while_headed_preserves_invoke() {
    for (policy, expected) in [
        (
            InteractionPolicy::headless(),
            "LegacyIAccessible.DoDefaultAction",
        ),
        (InteractionPolicy::headed(), "InvokePattern.Invoke"),
    ] {
        let calls = std::cell::RefCell::new(Vec::new());
        let steps = click_chain_judged_for(
            deadline(5_000),
            policy,
            ClickAvailability {
                invoke_available: true,
                legacy_available: true,
                invoke_requires_headed: true,
            },
            || {
                calls.borrow_mut().push("InvokePattern.Invoke");
                Ok(DeliveryOutcome::DeliveredUnverified)
            },
            || {
                calls.borrow_mut().push("LegacyIAccessible.DoDefaultAction");
                Ok(DeliveryOutcome::DeliveredUnverified)
            },
        )
        .expect("the correct mechanism can deliver");
        assert_eq!(calls.into_inner(), [expected]);
        assert_eq!(steps[0].label(), expected);
    }
}

#[test]
fn winforms_headless_click_without_legacy_never_calls_invoke() {
    let error = click_chain_judged_for(
        deadline(5_000),
        InteractionPolicy::headless(),
        ClickAvailability {
            invoke_available: true,
            legacy_available: false,
            invoke_requires_headed: true,
        },
        || panic!("Invoke can activate the target"),
        || panic!("Legacy is unavailable"),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}
