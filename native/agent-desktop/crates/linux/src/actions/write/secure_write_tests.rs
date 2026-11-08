use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use super::*;
use crate::actions::chain::chain_delivery_outcome::DeliveryOutcome;
use crate::actions::chain::chain_observed::Observed;
use crate::actions::write::text_write::fakes::{Fake, Script, drive, span};
use crate::actions::write::text_write::{insert_rungs, replace_rungs};

const SECRET: &str = "hunter2-correct-horse";

fn leaking(code: ErrorCode) -> AdapterError {
    AdapterError::new(code, format!("rejected {SECRET}"))
        .with_suggestion(format!("retry {SECRET}"))
        .with_platform_detail(format!("body {SECRET}"))
        .with_details(serde_json::json!({ "echo": SECRET }))
        .with_disposition(DeliverySemantics::not_delivered())
}

fn assert_clean(error: &AdapterError) {
    let rendered = format!(
        "{} {:?} {:?} {:?}",
        error.message, error.suggestion, error.platform_detail, error.details
    );
    assert!(!rendered.contains(SECRET), "{rendered}");
}

#[test]
fn a_password_role_is_secure_without_any_read() {
    assert!(is_secure(Some(40), None, false));
}

#[test]
fn the_secure_token_and_the_view_flag_each_mark_a_field_secure() {
    let tokens = vec!["secure".to_owned()];
    assert!(is_secure(Some(61), Some(&tokens), false));
    assert!(is_secure(None, None, true));
}

#[test]
fn an_ordinary_text_box_is_not_secure() {
    let tokens = vec!["editable".to_owned()];
    assert!(!is_secure(Some(61), Some(&tokens), false));
}

#[test]
fn a_secure_set_issues_no_read_and_carries_no_verdict() {
    let fake = Fake::holding("");
    let (_, outcome) = drive(&mut replace_rungs(&fake, SECRET, true)).expect("delivered");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Unread));
    assert_eq!(fake.reads.get(), 0);
}

#[test]
fn a_secure_clear_issues_no_read() {
    let fake = Fake::holding("");
    let (_, outcome) = drive(&mut replace_rungs(&fake, "", true)).expect("delivered");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Unread));
    assert_eq!(fake.reads.get(), 0);
}

#[test]
fn a_secure_type_issues_no_read_and_carries_no_verdict() {
    let mut fake = Fake::holding("");
    fake.caret = Ok(Some((0, vec![])));
    let (_, outcome) = drive(&mut insert_rungs(&fake, SECRET, true)).expect("delivered");
    assert_eq!(outcome, DeliveryOutcome::Delivered(Observed::Unread));
    assert_eq!(fake.reads.get(), 0);
}

#[test]
fn a_secure_field_never_falls_to_the_rung_that_needs_the_old_text() {
    let mut fake = Fake::holding("");
    fake.set = Script::Absent;
    let (_, outcome) = drive(&mut replace_rungs(&fake, SECRET, true)).expect("no error");
    assert_eq!(outcome, DeliveryOutcome::NotDelivered);
    assert_eq!(fake.reads.get(), 0);
    assert_eq!(fake.logged().len(), 1);
}

#[test]
fn a_failed_secure_set_does_not_echo_the_text() {
    let mut fake = Fake::holding("");
    fake.set = Script::Fail(leaking(ErrorCode::InvalidArgs));
    let error = drive(&mut replace_rungs(&fake, SECRET, true)).expect_err("failed");
    assert_clean(&error);
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn a_failed_secure_type_does_not_echo_the_text() {
    let mut fake = Fake::holding("");
    fake.caret = Ok(Some((0, span(0, 3))));
    fake.insert = Script::Fail(leaking(ErrorCode::InvalidArgs));
    let error = drive(&mut insert_rungs(&fake, SECRET, true)).expect_err("failed");
    assert_clean(&error);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}

#[test]
fn an_ordinary_error_is_left_as_it_came() {
    let error = scrub(leaking(ErrorCode::InvalidArgs), SECRET, false);
    assert!(error.message.contains(SECRET));
}
