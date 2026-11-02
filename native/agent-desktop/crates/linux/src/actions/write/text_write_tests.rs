use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use super::fakes::{Fake, Script, drive, span};
use super::*;
use crate::tree::capabilities::text_units::LengthUnit;

fn invalid() -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, "bad range")
        .with_disposition(DeliverySemantics::not_delivered())
}

fn replace(fake: &Fake, text: &str) -> Result<(&'static str, DeliveryOutcome), AdapterError> {
    drive(&mut replace_rungs(fake, text, false))
}

fn typed(fake: &Fake, text: &str) -> Result<(&'static str, DeliveryOutcome), AdapterError> {
    drive(&mut insert_rungs(fake, text, false))
}

#[test]
fn a_true_set_with_the_wrong_read_back_is_terminal_and_never_tries_rung_two() {
    let mut fake = Fake::holding("old");
    fake.landing = Some("hell".to_owned());
    let (_, outcome) = replace(&fake, "hello").expect("delivered");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Unchanged));
    assert_eq!(fake.logged(), ["set(hello)"]);
}

#[test]
fn an_absent_set_falls_to_delete_then_insert() {
    let mut fake = Fake::holding("old");
    fake.set = Script::Absent;
    let (label, outcome) = replace(&fake, "hi").expect("delivered");
    assert_eq!(label, REWRITE_LABEL);
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Matched));
    assert_eq!(fake.logged(), ["set(hi)", "delete(0,3)", "insert(0,2,hi)"]);
}

#[test]
fn a_delete_that_lands_before_a_failed_insert_is_delivered_unverified() {
    let mut fake = Fake::holding("old");
    fake.set = Script::Absent;
    fake.insert = Script::Fail(invalid());
    let error = replace(&fake, "hi").expect_err("the insert failed");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert!(error.suggestion.expect("a hint").contains("Read the field"));
}

#[test]
fn an_insert_that_answers_false_after_a_landed_delete_is_delivered_unverified() {
    let mut fake = Fake::holding("old");
    fake.set = Script::Absent;
    fake.insert = Script::Absent;
    let error = replace(&fake, "hi").expect_err("the insert was refused");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}

#[test]
fn a_transport_failure_after_a_landed_delete_stays_uncertain() {
    let mut fake = Fake::holding("old");
    fake.set = Script::Absent;
    fake.insert = Script::Fail(
        AdapterError::new(ErrorCode::Timeout, "no reply")
            .with_disposition(DeliverySemantics::uncertain()),
    );
    let error = replace(&fake, "hi").expect_err("uncertain");
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
}

#[test]
fn a_failed_first_delete_is_not_a_partial_write() {
    let mut fake = Fake::holding("old");
    fake.set = Script::Absent;
    fake.delete = Script::Fail(invalid());
    let error = replace(&fake, "hi").expect_err("the delete failed");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn clear_by_deleting_issues_no_insert() {
    let mut fake = Fake::holding("old");
    fake.set = Script::Absent;
    let (label, outcome) = replace(&fake, "").expect("delivered");
    assert_eq!(label, REWRITE_LABEL);
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Matched));
    assert_eq!(fake.logged(), ["set()", "delete(0,3)"]);
}

#[test]
fn clearing_an_already_empty_field_whose_set_is_absent_is_satisfied() {
    let mut fake = Fake::holding("");
    fake.set = Script::Absent;
    let (_, outcome) = replace(&fake, "").expect("satisfied");
    assert_eq!(outcome, DeliveryOutcome::Satisfied);
    assert_eq!(fake.logged(), ["set()"]);
}

#[test]
fn type_inserts_once_at_the_caret_with_no_delete() {
    let mut fake = Fake::holding("abcdef");
    fake.caret = Ok(Some((3, vec![])));
    let (_, outcome) = typed(&fake, "XY").expect("delivered");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Matched));
    assert_eq!(fake.logged(), ["insert(3,2,XY)"]);
}

#[test]
fn type_over_a_selection_deletes_it_then_inserts_at_its_start() {
    let mut fake = Fake::holding("abcdef");
    fake.caret = Ok(Some((2, span(1, 2))));
    let (_, outcome) = typed(&fake, "Z").expect("delivered");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Matched));
    assert_eq!(fake.logged(), ["delete(1,2)", "insert(1,1,Z)"]);
}

#[test]
fn an_empty_selection_range_is_not_deleted() {
    let mut fake = Fake::holding("abc");
    fake.caret = Ok(Some((1, span(1, 1))));
    typed(&fake, "Z").expect("delivered");
    assert_eq!(fake.logged(), ["insert(1,1,Z)"]);
}

#[test]
fn an_unreadable_caret_writes_nothing_and_is_not_delivered() {
    let fake = Fake::holding("abc");
    let error = typed(&fake, "Z").expect_err("no caret");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(fake.logged().is_empty());
}

#[test]
fn a_failed_insert_after_a_landed_selection_delete_is_delivered_unverified() {
    let mut fake = Fake::holding("abcdef");
    fake.caret = Ok(Some((2, span(1, 2))));
    fake.insert = Script::Fail(invalid());
    let error = typed(&fake, "Z").expect_err("insert failed");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert!(error.suggestion.expect("a hint").contains("Read the field"));
}

#[test]
fn a_failed_insert_with_nothing_deleted_stays_not_delivered() {
    let mut fake = Fake::holding("abc");
    fake.caret = Ok(Some((1, vec![])));
    fake.insert = Script::Fail(invalid());
    let error = typed(&fake, "Z").expect_err("insert failed");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn an_absent_insert_with_nothing_deleted_falls_through_as_not_delivered() {
    let mut fake = Fake::holding("abc");
    fake.caret = Ok(Some((1, vec![])));
    fake.insert = Script::Absent;
    let (_, outcome) = typed(&fake, "Z").expect("no error");
    assert_eq!(outcome, DeliveryOutcome::NotDelivered);
}

#[test]
fn an_unreadable_field_leaves_the_insert_unobserved() {
    let mut fake = Fake::holding("abc");
    fake.caret = Ok(Some((1, vec![])));
    *fake.text.borrow_mut() = None;
    let (_, outcome) = typed(&fake, "Z").expect("delivered");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Unread));
}

#[test]
fn an_insert_the_field_ignored_is_write_ignored_and_not_delivered() {
    let mut fake = Fake::holding("abc");
    fake.caret = Ok(Some((1, vec![])));
    fake.insert = Script::Ignore;
    let error = typed(&fake, "Z").expect_err("ignored");
    assert_ignored(&error);
}

#[test]
fn a_set_the_field_ignored_is_write_ignored_and_not_delivered() {
    let mut fake = Fake::holding("old");
    fake.set = Script::Ignore;
    let error = replace(&fake, "new").expect_err("ignored");
    assert_ignored(&error);
    assert_eq!(fake.logged(), ["set(new)"]);
}

#[test]
fn an_unreadable_old_value_cannot_prove_the_write_ignored() {
    let mut fake = Fake::holding("old");
    fake.set = Script::Ignore;
    let rungs = &mut replace_rungs(&fake, "new", false);
    *fake.text.borrow_mut() = None;
    let (_, outcome) = drive(rungs).expect("delivered");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Unread));
}

fn assert_ignored(error: &AdapterError) {
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let cause = error.details.as_ref().and_then(|d| d.get("cause"));
    assert_eq!(cause.and_then(|c| c.as_str()), Some("write_ignored"));
}

#[test]
fn the_read_only_refusal_is_action_not_supported_and_not_delivered() {
    let error = read_only_field();
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn a_qt_field_is_sent_the_utf16_length_so_it_reads_no_garbage_past_the_text() {
    let mut fake = Fake::holding("");
    fake.unit = LengthUnit::Utf16Units;
    fake.caret = Ok(Some((0, vec![])));
    typed(&fake, "\u{e9}").expect("delivered");
    typed(&fake, "\u{1F600}").expect("delivered");
    assert_eq!(
        fake.logged(),
        [
            "insert(0,1,\u{e9})".to_owned(),
            "insert(0,2,\u{1F600})".to_owned()
        ]
    );
}

#[test]
fn the_gecko_refusal_is_not_supported_not_delivered_and_names_its_cause() {
    for policy in [
        InteractionPolicy::headless(),
        InteractionPolicy::focus_fallback(),
        InteractionPolicy::headed(),
    ] {
        let error = editable_text_ignored(policy, "set-value");
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(
            error.details.expect("details")["cause"],
            "toolkit_ignores_editable_text"
        );
        let hint = error.suggestion.expect("recovery hint");
        assert_eq!(
            hint.contains("--headed type"),
            !policy.is_headed(),
            "{hint}"
        );
        if policy.is_headed() {
            assert!(hint.contains("'type' in the current headed mode"), "{hint}");
            assert!(!hint.contains("--headed"), "{hint}");
        }
    }
}

#[test]
fn ignored_semantic_type_does_not_repeat_an_exhausted_physical_route() {
    let error = editable_text_ignored(InteractionPolicy::headed(), "type");
    let hint = error.suggestion.expect("recovery hint");
    assert!(
        hint.contains("physical route and semantic text writes are unavailable"),
        "{hint}"
    );
    assert!(!hint.contains("Use 'type'"), "{hint}");
    assert!(!hint.contains("--headed"), "{hint}");
}
