//! The value-write chain's fallthrough policy, split from `chain_tests.rs`
//! for the per-file line cap. `continue_after_unverified_delivery` is a
//! general engine mechanism; these cases pin the policy the shipped chain
//! declares, which is `false`, so a future flip is caught.

use super::{ChainRung, DeliveryOutcome, execute_chain};
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::InteractionPolicy;
use std::cell::Cell;

#[test]
fn value_write_chain_stops_after_unverified_delivery_with_no_second_rung() {
    let first = Cell::new(0u8);
    let second = Cell::new(0u8);
    let mut first_run = || {
        first.set(first.get() + 1);
        Ok(DeliveryOutcome::DeliveredUnverified)
    };
    let mut second_run = || {
        second.set(second.get() + 1);
        Ok(DeliveryOutcome::DeliveredVerified)
    };
    let steps = execute_chain(
        deadline(5_000),
        &crate::actions::value_write::VALUE_WRITE_CHAIN,
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
    .expect("an unverified delivery terminates the chain");
    assert_eq!(first.get(), 1);
    assert_eq!(second.get(), 0);
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].label(), "ValuePattern.SetValue");
    assert_eq!(steps[0].verified(), Some(false));
}
