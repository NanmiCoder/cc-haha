use super::chain_observed::Observed;
use std::cell::Cell;
use std::time::Duration;

use agent_desktop_core::{ActionStepOutcome, DeliveryDisposition, RetryDisposition};

use super::*;

const DEF: ChainDef = ChainDef {
    action: "click",
    suggestion: "Refresh the snapshot",
};

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("a deadline builds")
}

fn rung<'a>(
    label: &'static str,
    calls: &'a Cell<u32>,
    outcome: Result<DeliveryOutcome, AdapterError>,
) -> Rung<'a> {
    Rung {
        label,
        run: Box::new(move || {
            calls.set(calls.get() + 1);
            outcome.clone()
        }),
    }
}

#[test]
fn a_not_delivered_rung_advances_to_the_next() {
    let (first, second) = (Cell::new(0), Cell::new(0));
    let mut rungs = [
        rung("one", &first, Ok(DeliveryOutcome::NotDelivered)),
        rung(
            "two",
            &second,
            Ok(DeliveryOutcome::Delivered(Observed::Matched)),
        ),
    ];
    let result = execute_chain(&DEF, &mut rungs, deadline()).expect("the second rung delivers");
    assert_eq!((first.get(), second.get()), (1, 1));
    assert_eq!(result.steps.len(), 2);
    assert!(matches!(
        result.steps[0].outcome,
        ActionStepOutcome::Skipped
    ));
    assert!(matches!(
        result.steps[1].outcome,
        ActionStepOutcome::Succeeded
    ));
}

#[test]
fn a_delivered_rung_ends_the_chain_before_the_next_runs() {
    let (first, second) = (Cell::new(0), Cell::new(0));
    let mut rungs = [
        rung(
            "one",
            &first,
            Ok(DeliveryOutcome::Delivered(Observed::Unread)),
        ),
        rung(
            "two",
            &second,
            Ok(DeliveryOutcome::Delivered(Observed::Matched)),
        ),
    ];
    execute_chain(&DEF, &mut rungs, deadline()).expect("the first rung delivers");
    assert_eq!((first.get(), second.get()), (1, 0));
}

#[test]
fn a_genuine_error_aborts_with_that_error_and_no_later_rung_runs() {
    let (first, second) = (Cell::new(0), Cell::new(0));
    let refusal = AdapterError::new(ErrorCode::PermDenied, "refused");
    let mut rungs = [
        rung("one", &first, Err(refusal)),
        rung(
            "two",
            &second,
            Ok(DeliveryOutcome::Delivered(Observed::Matched)),
        ),
    ];
    let error = execute_chain(&DEF, &mut rungs, deadline()).expect_err("the error aborts");
    assert_eq!(error.code, ErrorCode::PermDenied);
    assert_eq!((first.get(), second.get()), (1, 0));
}

#[test]
fn exhaustion_is_action_failed_with_the_suggestion_and_the_steps_tried() {
    let (first, second) = (Cell::new(0), Cell::new(0));
    let mut rungs = [
        rung("one", &first, Ok(DeliveryOutcome::NotDelivered)),
        rung("two", &second, Ok(DeliveryOutcome::NotDelivered)),
    ];
    let error = execute_chain(&DEF, &mut rungs, deadline()).expect_err("nothing delivers");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.suggestion.as_deref(), Some(DEF.suggestion));
    assert_eq!(
        error.details.as_ref().map(|d| d["steps_tried"].clone()),
        Some(serde_json::json!(["one", "two"]))
    );
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn a_satisfied_outcome_is_not_delivered_and_safe_to_retry() {
    let calls = Cell::new(0);
    let mut rungs = [rung("one", &calls, Ok(DeliveryOutcome::Satisfied))];
    let result = execute_chain(&DEF, &mut rungs, deadline()).expect("already satisfied");
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(result.disposition().retry(), RetryDisposition::Safe);
    assert_eq!(result.steps[0].verified(), Some(true));
}

#[test]
fn the_verified_field_follows_the_re_read() {
    let cases = [
        (
            Observed::Matched,
            Some(true),
            DeliveryDisposition::DeliveredVerified,
        ),
        (
            Observed::Unchanged,
            Some(false),
            DeliveryDisposition::DeliveredUnverified,
        ),
        (
            Observed::Unread,
            None,
            DeliveryDisposition::DeliveredUnverified,
        ),
    ];
    for (observed, verified, delivery) in cases {
        let calls = Cell::new(0);
        let mut rungs = [rung(
            "one",
            &calls,
            Ok(DeliveryOutcome::Delivered(observed)),
        )];
        let result = execute_chain(&DEF, &mut rungs, deadline()).expect("delivered");
        assert_eq!(result.steps[0].verified(), verified, "{observed:?}");
        assert_eq!(result.disposition().delivery(), delivery, "{observed:?}");
    }
}

#[test]
fn a_deadline_spent_between_rungs_is_a_timeout_stamped_not_delivered() {
    let calls = Cell::new(0);
    let spent = Deadline::after(1).expect("a deadline builds");
    std::thread::sleep(Duration::from_millis(10));
    let mut rungs = [rung(
        "one",
        &calls,
        Ok(DeliveryOutcome::Delivered(Observed::Matched)),
    )];
    let error = execute_chain(&DEF, &mut rungs, spent).expect_err("the budget is spent");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(error.disposition.retry(), RetryDisposition::Safe);
    assert_eq!(calls.get(), 0);
}

#[test]
fn exhaustion_names_each_rung_and_why_it_did_not_deliver() {
    let (first, second) = (Cell::new(0), Cell::new(0));
    let mut rungs = [
        rung("one", &first, Ok(DeliveryOutcome::NotDelivered)),
        rung("two", &second, Ok(DeliveryOutcome::NotDelivered)),
    ];
    let error = execute_chain(&DEF, &mut rungs, deadline()).expect_err("nothing delivers");
    let details = error.details.expect("details");
    assert_eq!(
        details["rungs"],
        serde_json::json!([
            { "label": "one", "outcome": "not_delivered", "cause": "affordance_absent" },
            { "label": "two", "outcome": "not_delivered", "cause": "affordance_absent" }
        ])
    );
    assert_ne!(error.message, "All chain steps exhausted");
}
