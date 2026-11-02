//! Physical-input targeting cases that need neither a desktop nor an element.
#![cfg(all(test, target_os = "windows"))]

use super::incomplete_climb_error;
use agent_desktop_core::{Deadline, DeliverySemantics, ErrorCode};

fn open_deadline() -> Deadline {
    Deadline::after(5_000).expect("deadline")
}

fn expired_deadline() -> Deadline {
    let deadline = Deadline::after(1).expect("tiny deadline");
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert!(
        deadline.is_expired(),
        "the staged deadline must have run out"
    );
    deadline
}

/// The consumer used to answer `TIMEOUT` for every refusal the climb could
/// raise, so a faulted read told the caller to wait and retry the same ref
/// against an element whose read had just failed. A fault keeps its own code,
/// which is the one that asks for a fresh snapshot.
#[test]
fn a_climb_that_faulted_inside_its_budget_is_not_a_timeout() {
    let error = incomplete_climb_error(open_deadline());

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        error.disposition,
        DeliverySemantics::NotDelivered,
        "nothing was injected, so the caller may retry after refreshing"
    );
}

/// The other direction, which is what stops the fix becoming its own
/// collapse: a budget that really has run out is still a timeout.
#[test]
fn a_climb_that_ran_out_of_budget_is_still_a_timeout() {
    assert_eq!(
        incomplete_climb_error(expired_deadline()).code,
        ErrorCode::Timeout
    );
}
