//! The chain's budget-expiry cases.
//!
//! Split from `chain_tests.rs` so that file stays inside the size cap. These
//! cases are about what an expiry *reports* rather than about what a rung
//! does, and they are the only ones here that depend on wall-clock time.

use super::{ChainDef, ChainRung, DeliveryOutcome, execute_chain};
use agent_desktop_core::{Deadline, ErrorCode, InteractionPolicy};

/// A deadline that expires between rungs used to report `unknown`, discarding
/// the steps already recorded - so a write that had been delivered but not
/// verified was described as if nothing had happened. The rung-error path
/// already carried its steps; this is the same rule on the timeout path.
#[test]
fn budget_expiry_after_an_unverified_delivery_reports_delivered_unverified() {
    let mut first_run = || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        Ok(DeliveryOutcome::DeliveredUnverified)
    };
    let mut second_run = || Ok(DeliveryOutcome::DeliveredVerified);
    let def = ChainDef {
        suggestion: "retry",
        continue_after_unverified_delivery: true,
    };

    let error = execute_chain(
        Deadline::after(300).expect("deadline"),
        &def,
        InteractionPolicy::headless(),
        &mut [
            ChainRung {
                label: "ValuePattern.SetValue",
                requires_headed: false,
                run: &mut first_run,
            },
            ChainRung {
                label: "RangeValuePattern.SetValue",
                requires_headed: false,
                run: &mut second_run,
            },
        ],
    )
    .expect_err("the budget expires before the second rung is reached");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition.delivery(),
        agent_desktop_core::DeliveryDisposition::DeliveredUnverified,
        "a rung already delivered without verification, so the expiry must say so rather than \
         report an unknown delivery a caller cannot act on"
    );
}

/// The other direction: an expiry with nothing recorded still says nothing was
/// delivered, which is what makes the case above a claim rather than a default.
#[test]
fn budget_expiry_before_any_rung_reports_not_delivered() {
    let mut never_run = || Ok(DeliveryOutcome::DeliveredVerified);
    let def = ChainDef {
        suggestion: "retry",
        continue_after_unverified_delivery: true,
    };

    let error = execute_chain(
        Deadline::after(0).expect("deadline"),
        &def,
        InteractionPolicy::headless(),
        &mut [ChainRung {
            label: "ValuePattern.SetValue",
            requires_headed: false,
            run: &mut never_run,
        }],
    )
    .expect_err("an exhausted budget refuses before the first rung");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition.delivery(),
        agent_desktop_core::DeliveryDisposition::NotDelivered
    );
}
