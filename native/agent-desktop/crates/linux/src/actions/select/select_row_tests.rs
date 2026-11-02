use std::cell::Cell;

use agent_desktop_core::{ActionStep, DeliveryDisposition, DeliverySemantics, ErrorCode};

use super::*;

struct Clicks {
    count: Cell<usize>,
    refuse: bool,
}

impl Clicks {
    fn new(refuse: bool) -> Self {
        Self {
            count: Cell::new(0),
            refuse,
        }
    }
}

impl Pointer for Clicks {
    fn click(&self, _: &AtspiElement) -> Result<Vec<ActionStep>, AdapterError> {
        self.count.set(self.count.get() + 1);
        if self.refuse {
            return Err(AdapterError::new(ErrorCode::ActionFailed, "refused")
                .with_disposition(DeliverySemantics::not_delivered()));
        }
        Ok(vec![ActionStep::succeeded("XTEST.click")])
    }

    fn escape(&self) -> Result<Vec<ActionStep>, AdapterError> {
        Ok(Vec::new())
    }
}

fn row() -> AtspiElement {
    AtspiElement::new(":1.2", "/row", 7)
}

fn short() -> Deadline {
    Deadline::after(150).expect("a short deadline")
}

fn answers(
    reads: &Cell<usize>,
    sequence: Vec<Option<bool>>,
) -> Box<dyn FnMut() -> Option<bool> + '_> {
    let mut sequence = sequence.into_iter();
    let mut last = None;
    Box::new(move || {
        reads.set(reads.get() + 1);
        if let Some(next) = sequence.next() {
            last = next;
        }
        last
    })
}

#[test]
fn a_row_that_is_selected_already_is_not_clicked() {
    let reads = Cell::new(0);
    let clicks = Clicks::new(false);
    let result = click_until_selected(&row(), &clicks, short(), answers(&reads, vec![Some(true)]))
        .expect("already selected");
    assert_eq!(clicks.count.get(), 0);
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn a_clicked_row_that_reads_selected_is_delivered_and_verified() {
    let reads = Cell::new(0);
    let clicks = Clicks::new(false);
    let result = click_until_selected(
        &row(),
        &clicks,
        short(),
        answers(&reads, vec![Some(false), Some(true)]),
    )
    .expect("selected");
    assert_eq!(clicks.count.get(), 1);
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredVerified
    );
    assert_eq!(result.steps[0].verified(), Some(true));
}

#[test]
fn a_clicked_row_that_stays_unselected_is_a_write_ignored_failure() {
    let reads = Cell::new(0);
    let clicks = Clicks::new(false);
    let error = click_until_selected(&row(), &clicks, short(), answers(&reads, vec![Some(false)]))
        .expect_err("not selected");
    assert_eq!(clicks.count.get(), 1);
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(error.details.expect("details")["cause"], "write_ignored");
}

#[test]
fn a_click_the_pointer_refuses_is_returned_before_any_read_back() {
    let reads = Cell::new(0);
    let clicks = Clicks::new(true);
    let error = click_until_selected(&row(), &clicks, short(), answers(&reads, vec![Some(false)]))
        .expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(reads.get(), 1);
}

#[test]
fn a_clicked_row_whose_state_cannot_be_read_is_delivered_but_unverified() {
    let reads = Cell::new(0);
    let clicks = Clicks::new(false);
    let result = click_until_selected(
        &row(),
        &clicks,
        short(),
        answers(&reads, vec![Some(false), None]),
    )
    .expect("delivered");
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
}
