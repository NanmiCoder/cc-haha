use std::cell::Cell;

use agent_desktop_core::{
    ActionResult, ActionStep, AdapterError, DeliveryDisposition, DeliverySemantics, ErrorCode,
};

use super::*;
use crate::actions::select::select_index::{IndexLookup, resolve};
use crate::actions::select::select_search::Search;
use crate::actions::select::{miss_error, no_route};
use crate::actions::write::mutation::WriteReply;

struct NoIndices;

impl IndexLookup for NoIndices {
    fn accessible_indices(&self) -> bool {
        false
    }

    fn counted_indices(&self) -> Result<bool, AdapterError> {
        Ok(false)
    }

    fn index(&self, _: &AtspiElement) -> Result<i32, AdapterError> {
        panic!("an unproven toolkit reads no index");
    }

    fn child(&self, _: i32) -> Result<(String, String), AdapterError> {
        panic!("an unproven toolkit reads no child");
    }

    fn select(&self, _: i32) -> Result<WriteReply, AdapterError> {
        panic!("an unproven toolkit writes nothing");
    }
}

#[derive(Default)]
struct Counting {
    clicks: Cell<usize>,
}

impl Pointer for Counting {
    fn click(&self, _: &AtspiElement) -> Result<Vec<ActionStep>, AdapterError> {
        self.clicks.set(self.clicks.get() + 1);
        Ok(vec![ActionStep::succeeded("XTEST.click")])
    }

    fn escape(&self) -> Result<Vec<ActionStep>, AdapterError> {
        Ok(Vec::new())
    }
}

fn row() -> AtspiElement {
    AtspiElement::new(":1.2", "/row", 7)
}

fn unproven() -> AdapterError {
    resolve(&NoIndices, &row()).expect_err("an unproven index is refused")
}

fn clicked_and_matched(pointer: &dyn Pointer) -> Result<ActionResult, AdapterError> {
    let steps = pointer.click(&row())?;
    by_pointer_result(steps, Observed::Matched)
}

#[test]
fn only_the_unproven_index_refusal_is_one_a_pointer_takes_over() {
    assert!(is_unproven_index(&unproven()));
    let others = [
        no_route(),
        miss_error(&Search::NotFound { selectable: true }),
        AdapterError::new(ErrorCode::ActionNotSupported, "another refusal")
            .with_disposition(DeliverySemantics::not_delivered()),
        unproven().with_disposition(DeliverySemantics::delivered_unverified()),
    ];
    for other in others {
        assert!(!is_unproven_index(&other), "{other:?}");
    }
}

#[test]
fn a_headed_select_goes_on_by_pointer_after_an_unproven_index_and_records_the_refusal() {
    let pointer = Counting::default();
    let result = after_unproven_index(Some(&pointer), || Err(unproven()), clicked_and_matched)
        .expect("the pointer delivers");
    assert_eq!(pointer.clicks.get(), 1);
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredVerified
    );
    let labels: Vec<&str> = result.steps.iter().map(ActionStep::label).collect();
    assert_eq!(labels, ["Selection.SelectChild", "XTEST.click"]);
    let details = result.details.expect("the refusal is recorded");
    assert_eq!(
        details["semantic_refusal"]["details"]["kind"],
        "selection_index_unproven"
    );
}

#[test]
fn a_headless_select_keeps_the_unproven_index_refusal_and_reaches_no_pointer() {
    let error = after_unproven_index(None, || Err(unproven()), |_| panic!("headless input"))
        .expect_err("the refusal stands");
    assert!(is_unproven_index(&error));
}

#[test]
fn a_headed_select_that_failed_for_another_reason_is_not_retried_by_pointer() {
    let pointer = Counting::default();
    let error = after_unproven_index(Some(&pointer), || Err(no_route()), clicked_and_matched)
        .expect_err("the refusal stands");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(pointer.clicks.get(), 0);
}

#[test]
fn a_semantic_select_that_delivered_is_never_repeated_by_pointer() {
    let pointer = Counting::default();
    let delivered = || Ok(ActionResult::delivered_unverified("select"));
    after_unproven_index(Some(&pointer), delivered, clicked_and_matched).expect("delivered");
    assert_eq!(pointer.clicks.get(), 0);
}

#[test]
fn a_pointer_select_is_verified_only_by_the_read_back() {
    let steps = || vec![ActionStep::succeeded("XTEST.click")];
    let matched = by_pointer_result(steps(), Observed::Matched).expect("matched");
    assert_eq!(
        matched.disposition().delivery(),
        DeliveryDisposition::DeliveredVerified
    );
    assert_eq!(matched.steps[0].verified(), Some(true));
    let unread = by_pointer_result(steps(), Observed::Unread).expect("unread");
    assert_eq!(
        unread.disposition().delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
    assert_eq!(unread.steps[0].verified(), None);
    let error = by_pointer_result(steps(), Observed::Unchanged).expect_err("unchanged");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(error.details.expect("details")["cause"], "write_ignored");
}

#[test]
fn a_headless_pointer_only_select_is_a_policy_refusal_with_nothing_sent() {
    let error = pointer_required();
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let suggestion = error.suggestion.expect("suggestion");
    assert!(suggestion.contains("--headed") && suggestion.contains("X11"));
    let details = error.details.expect("details");
    assert_eq!(details["kind"], "pointer_required");
    assert_eq!(details["physical_delivery_started"], false);
}
