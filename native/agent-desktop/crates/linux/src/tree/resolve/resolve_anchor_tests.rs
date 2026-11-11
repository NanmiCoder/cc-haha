use agent_desktop_core::{AdapterError, ErrorCode};

use super::*;
use crate::tree::live::test_support::attributes;
use crate::tree::resolve::resolve_errors::{app_exited, is_incomplete, window_replaced};
use crate::tree::resolve::resolve_fake::{BUS, FRAME_PATH, Fake, WINDOW_PID, deadline, node};
use crate::tree::vocabulary::role_numbers::{DOCUMENT_WEB, PANEL, PUSH_BUTTON};

fn files() -> Fake {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/toolbar", node(PANEL, "toolbar", 800, 40));
    fake.add("/toolbar", "/opts1", node(PUSH_BUTTON, "Options", 34, 34));
    fake.add("/toolbar", "/opts2", node(PUSH_BUTTON, "Options", 23, 34));
    fake.add(FRAME_PATH, "/back", node(PUSH_BUTTON, "Back", 30, 30));
    fake
}

fn kind(error: &AdapterError) -> &str {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
}

fn landed(fake: &mut Fake, entry: &agent_desktop_core::RefEntry) -> AtspiElement {
    resolve_anchor(fake, entry, deadline()).expect("the anchor lands")
}

fn refused(fake: &mut Fake, entry: &agent_desktop_core::RefEntry) -> AdapterError {
    resolve_anchor(fake, entry, deadline()).expect_err("the anchor is refused")
}

#[test]
fn the_landed_handle_keeps_the_frame_and_the_web_context_it_was_found_under() {
    let mut fake = Fake::new();
    fake.add(
        FRAME_PATH,
        "/document",
        node(DOCUMENT_WEB, "page", 800, 500),
    );
    let mut save = node(PUSH_BUTTON, "Save", 60, 24);
    save.node.attributes = attributes(&[("id", "save-button")]);
    fake.add("/document", "/save", save);
    let entry = fake.entry_of("/save", true);
    let element = landed(&mut fake, &entry);
    assert!(element.in_web_document());
    assert_eq!(element.frame().map(|frame| frame.pid()), Some(WINDOW_PID));
    assert_eq!(element.frame().map(|frame| frame.bus_name()), Some(BUS));
    let evidence = fake.evidence(&element).expect("reads");
    assert!(
        evidence
            .identifiers
            .preferred_identifier()
            .is_some_and(|id| id.kind == agent_desktop_core::IdentifierKind::AxDomIdentifier)
    );
}

#[test]
fn a_path_that_now_leads_to_another_role_is_stale_even_though_the_role_exists_elsewhere() {
    let mut fake = files();
    let mut entry = fake.entry_of("/back", true);
    entry.scope.path = [0].into_iter().collect();
    let error = refused(&mut fake, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind(&error), "resolve_no_candidate");
    assert!(error.is_explicitly_retryable());
    assert_eq!(fake.reads.searches, 0);
}

#[test]
fn a_path_that_leads_nowhere_is_stale_at_once() {
    let mut fake = files();
    let mut entry = fake.entry_of("/back", true);
    entry.scope.path = [0, 7].into_iter().collect();
    let error = refused(&mut fake, &entry);
    assert_eq!(kind(&error), "resolve_no_candidate");
    assert!(error.is_explicitly_retryable());
    assert_eq!(fake.reads.searches, 0);
    assert_eq!(fake.reads.evidence, 0);
}

#[test]
fn the_empty_path_lands_on_the_window_frame() {
    let mut fake = files();
    let entry = fake.entry_of(FRAME_PATH, true);
    assert!(entry.scope.path.is_empty());
    assert_eq!(landed(&mut fake, &entry).path(), FRAME_PATH);
}

#[test]
fn a_level_that_cannot_be_read_keeps_an_incomplete_retryable_ref() {
    let mut fake = files();
    let entry = fake.entry_of("/opts2", true);
    fake.nodes
        .get_mut("/toolbar")
        .expect("toolbar")
        .children_unread = true;
    let error = refused(&mut fake, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert!(error.is_explicitly_retryable());
    assert!(is_incomplete(&error));
    assert_eq!(error.details.as_ref().expect("details")["complete"], false);
}

#[test]
fn a_node_on_the_path_that_answers_as_destroyed_is_terminal() {
    let mut fake = files();
    let entry = fake.entry_of("/opts2", true);
    fake.faults.level_errors.insert(
        "/toolbar".to_owned(),
        AdapterError::new(ErrorCode::ElementNotFound, "gone"),
    );
    let error = refused(&mut fake, &entry);
    assert_eq!(kind(&error), "resolve_target_destroyed");
    assert!(!error.permits_retry_by_default());

    let mut fake = files();
    fake.faults.evidence_errors.insert(
        "/opts2".to_owned(),
        AdapterError::new(ErrorCode::ElementNotFound, "gone"),
    );
    let error = refused(&mut fake, &entry);
    assert_eq!(kind(&error), "resolve_target_destroyed");
    assert!(!error.permits_retry_by_default());
}

#[test]
fn a_landing_whose_evidence_cannot_be_read_is_retried() {
    let mut fake = files();
    let entry = fake.entry_of("/opts2", true);
    fake.faults.evidence_errors.insert(
        "/opts2".to_owned(),
        AdapterError::internal("a field failed"),
    );
    let error = refused(&mut fake, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert!(error.is_explicitly_retryable());
    assert!(is_incomplete(&error));
    assert_eq!(error.details.as_ref().expect("details")["complete"], false);
}

#[test]
fn the_window_gate_refusals_apply_and_nothing_is_read_after_them() {
    for (refusal, expected) in [
        (window_replaced(), "resolve_window_replaced"),
        (app_exited(), "resolve_owning_process_exited"),
    ] {
        let mut fake = files();
        let entry = fake.entry_of("/opts2", true);
        fake.faults.gate_error = Some(refusal);
        let error = refused(&mut fake, &entry);
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(kind(&error), expected);
        assert!(!error.is_explicitly_retryable());
        assert_eq!(fake.reads.levels + fake.reads.evidence, 0);
    }
}

#[test]
fn an_unnamed_zero_area_container_is_landed_by_its_path_for_the_caller_to_verify() {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/group", node(PANEL, "", 710, 0));
    let entry = fake.entry_of("/group", true);
    assert!(crate::tree::resolve::resolve_identity::entry_is_unverifiable(&entry));
    assert_eq!(landed(&mut fake, &entry).path(), "/group");
}

#[test]
fn an_expired_deadline_is_a_timeout_and_a_stopped_process_makes_it_unresponsive() {
    let mut fake = files();
    let entry = fake.entry_of("/opts2", true);
    let spent = agent_desktop_core::Deadline::after(0).expect("a zero deadline builds");
    let error = resolve_anchor(&mut fake, &entry, spent).expect_err("spent");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(fake.reads.gate, 0);

    fake.stopped = Some("Files".to_owned());
    let error = resolve_anchor(&mut fake, &entry, spent).expect_err("spent");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}
