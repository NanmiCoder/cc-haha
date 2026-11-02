use std::cell::Cell;

use agent_desktop_core::{Action, DeliverySemantics, ErrorCode};

use super::*;
use crate::tree::vocabulary::role_numbers::{CHECK_BOX, PUSH_BUTTON, TOGGLE_BUTTON};

fn counted_drive(
    wanted: bool,
    current: Flag,
    reply: Result<WriteReply, AdapterError>,
    after: Flag,
) -> (Result<DeliveryOutcome, AdapterError>, u32) {
    let writes = Cell::new(0);
    let outcome = drive_to(
        wanted,
        current,
        || {
            writes.set(writes.get() + 1);
            reply
        },
        || after,
    );
    (outcome, writes.get())
}

#[test]
fn check_on_a_checked_node_is_satisfied_and_writes_nothing() {
    let (outcome, writes) = counted_drive(true, Flag::On, Ok(WriteReply::Done), Flag::On);
    assert_eq!(outcome.expect("satisfied"), DeliveryOutcome::Satisfied);
    assert_eq!(writes, 0);
}

#[test]
fn an_unreadable_state_is_refused_with_no_write() {
    let (outcome, writes) = counted_drive(true, Flag::Unknown, Ok(WriteReply::Done), Flag::On);
    let error = outcome.expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(writes, 0);
}

#[test]
fn an_absent_verb_reply_is_not_delivered() {
    let (outcome, _) = counted_drive(true, Flag::Off, Ok(WriteReply::Absent), Flag::Off);
    assert_eq!(outcome.expect("answered"), DeliveryOutcome::NotDelivered);
}

#[test]
fn a_refused_write_keeps_its_code_and_is_never_repeated() {
    let invalid = AdapterError::new(ErrorCode::InvalidArgs, "bad");
    let (outcome, writes) = counted_drive(true, Flag::Off, Err(invalid), Flag::Off);
    assert_eq!(
        outcome.expect_err("passed through").code,
        ErrorCode::InvalidArgs
    );
    assert_eq!(writes, 1);
}

#[test]
fn a_toggle_button_reads_pressed_as_checked() {
    let on = checked_flag(TOGGLE_BUTTON, Some(false), Some(true), None).expect("read");
    assert_eq!(on, Flag::On);
    let off = checked_flag(TOGGLE_BUTTON, Some(false), Some(false), None).expect("read");
    assert_eq!(off, Flag::Off);
}

#[test]
fn a_check_box_ignores_pressed() {
    let flag = checked_flag(CHECK_BOX, Some(false), Some(true), None).expect("read");
    assert_eq!(flag, Flag::Off);
}

#[test]
fn unread_bits_leave_the_state_unknown() {
    assert_eq!(
        checked_flag(CHECK_BOX, None, None, None).expect("read"),
        Flag::Unknown
    );
    assert_eq!(
        checked_flag(TOGGLE_BUTTON, Some(false), None, None).expect("read"),
        Flag::Unknown
    );
}

#[test]
fn an_indeterminate_node_is_refused() {
    let error = checked_flag(CHECK_BOX, Some(false), None, Some(true)).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn a_push_button_cannot_carry_checked() {
    for action in [Action::Toggle, Action::Check, Action::Uncheck] {
        let error = guard_role(Some(PUSH_BUTTON), &action).expect_err("refused");
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
}

#[test]
fn an_unread_role_is_refused_without_a_support_claim() {
    let error = guard_role(None, &Action::Check).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}
