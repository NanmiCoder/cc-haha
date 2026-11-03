use std::cell::{Cell, RefCell};

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use super::*;
use crate::actions::chain::chain_delivery_outcome::DeliveryOutcome;

struct Control {
    maximum: f64,
    reply: WriteReply,
    held: RefCell<f64>,
    sets: Cell<usize>,
    readable: bool,
}

impl Control {
    fn slider() -> Self {
        Self {
            maximum: 100.0,
            reply: WriteReply::Done,
            held: RefCell::new(0.0),
            sets: Cell::new(0),
            readable: true,
        }
    }
}

impl NumericPort for Control {
    fn set(&self, value: f64) -> Result<WriteReply, AdapterError> {
        self.sets.set(self.sets.get() + 1);
        if self.reply == WriteReply::Done {
            *self.held.borrow_mut() = value.min(self.maximum);
        }
        Ok(self.reply)
    }

    fn stored(&self) -> Option<f64> {
        self.readable.then(|| *self.held.borrow())
    }
}

fn write(control: &Control, plan: Plan) -> Result<DeliveryOutcome, AdapterError> {
    let mut rungs = write_rungs(control, plan);
    (rungs[0].run)()
}

fn planned(request: &str, spin: bool, step: Option<f64>) -> Plan {
    plan(request, spin, step).expect("a valid plan")
}

#[test]
fn a_value_above_the_range_reads_back_clamped_and_is_a_mismatch() {
    let control = Control::slider();
    let outcome = write(&control, planned("500", false, None)).expect("written");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Unchanged));
    assert_eq!(*control.held.borrow(), 100.0);
}

#[test]
fn a_whole_step_spin_button_can_commit_a_fraction() {
    let control = Control::slider();
    let outcome = write(&control, planned("7.5", true, Some(1.0))).expect("written");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Matched));
    assert_eq!(*control.held.borrow(), 7.5);
    assert_eq!(control.sets.get(), 1);
}

#[test]
fn a_fraction_on_a_spin_button_with_an_unreadable_step_is_not_proved_by_the_read_back() {
    let control = Control::slider();
    let plan = planned("7.5", true, None);
    assert!(!plan.readback_proves_commit);
    let outcome = write(&control, plan).expect("written");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Unread));
}

#[test]
fn a_non_numeric_or_non_finite_request_is_invalid_args() {
    for request in ["abc", "", "NaN", "inf", "-inf", "1e999", "7,5"] {
        let error = plan(request, false, None).expect_err(request);
        assert_eq!(error.code, ErrorCode::InvalidArgs, "{request}");
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
}

#[test]
fn a_read_only_answer_is_action_not_supported_and_not_delivered() {
    let mut control = Control::slider();
    control.reply = WriteReply::Absent;
    let error = write(&control, planned("5", false, None)).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn an_unreadable_value_after_the_write_is_unobserved() {
    let mut control = Control::slider();
    control.readable = false;
    let outcome = write(&control, planned("5", false, None)).expect("written");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Unread));
}

#[test]
fn a_value_that_stays_at_its_old_reading_is_write_ignored_and_not_delivered() {
    let mut control = Control::slider();
    control.reply = WriteReply::Done;
    control.maximum = 0.0;
    let error = write(&control, planned("5", false, None)).expect_err("ignored");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let cause = error.details.as_ref().and_then(|d| d.get("cause"));
    assert_eq!(cause.and_then(|c| c.as_str()), Some("write_ignored"));
}

#[test]
fn a_large_clamped_change_is_delivered_even_when_it_is_close_to_the_old_value() {
    let mut control = Control::slider();
    control.maximum = 1_000_000_001.0;
    *control.held.borrow_mut() = 1_000_000_000.0;
    let outcome = write(&control, planned("2000000000", false, None)).expect("the value changed");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Unchanged));
    assert_eq!(*control.held.borrow(), 1_000_000_001.0);
}
