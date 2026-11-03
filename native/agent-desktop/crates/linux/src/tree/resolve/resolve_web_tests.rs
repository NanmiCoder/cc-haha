use super::*;
use crate::tree::Field;
use crate::tree::live::test_support::attributes;
use crate::tree::resolve::resolve_fake::{BUS, FRAME_PATH, Fake, WINDOW_PID, deadline, node};
use crate::tree::vocabulary::role_numbers::{DOCUMENT_WEB, PANEL, PUSH_BUTTON};
use agent_desktop_core::ErrorCode;

fn page() -> Fake {
    let mut fake = Fake::new();
    fake.add(
        FRAME_PATH,
        "/document",
        node(DOCUMENT_WEB, "page", 800, 500),
    );
    let mut save = node(PUSH_BUTTON, "Save", 60, 24);
    save.node.attributes = attributes(&[("id", "save-button")]);
    fake.add("/document", "/save", save);
    fake
}

fn rows() -> Fake {
    let mut fake = Fake::new();
    for (path, name, width) in [
        ("/alpha", "alpha", 100),
        ("/beta", "beta", 100),
        ("/gamma", "gamma", 120),
    ] {
        let mut row = node(PUSH_BUTTON, name, width, 20);
        row.node.properties.accessible_id = Field::Present("app.list.row".to_owned());
        fake.add(FRAME_PATH, path, row);
    }
    fake
}

#[test]
fn a_dom_id_ref_keeps_the_web_context_with_or_without_a_stored_path() {
    let mut fake = page();
    let entry = fake.entry_of("/save", true);
    assert_eq!(
        entry.identity.native_id.as_ref().map(|id| id.kind),
        Some(agent_desktop_core::IdentifierKind::AxDomIdentifier)
    );
    let by_path = resolve(&mut fake, &entry, deadline()).expect("resolves");
    assert_eq!(by_path.path(), "/save");
    assert!(by_path.in_web_document());

    let mut without_path = entry.clone();
    without_path.scope.path.clear();
    let by_search = resolve(&mut fake, &without_path, deadline()).expect("resolves");
    assert_eq!(by_search.path(), "/save");
    assert!(by_search.in_web_document());
}

#[test]
fn rows_that_share_a_native_id_resolve_to_the_one_whose_text_matches() {
    let mut fake = rows();
    let mut beta = fake.entry_of("/beta", true);
    beta.scope.path.clear();
    let found = resolve(&mut fake, &beta, deadline()).expect("resolves");
    assert_eq!(found.path(), "/beta");
}

#[test]
fn rows_with_equal_text_and_equal_size_stay_ambiguous() {
    let mut fake = rows();
    fake.nodes
        .get_mut("/beta")
        .expect("beta")
        .read
        .node
        .properties
        .name = Field::Present("alpha".to_owned());
    let mut alpha = fake.entry_of("/alpha", true);
    alpha.scope.path.clear();
    let error = resolve(&mut fake, &alpha, deadline()).expect_err("ambiguous");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
}

fn remote_panel() -> Fake {
    let mut fake = Fake::new();
    fake.pids.insert(":1.7".to_owned(), 41);
    fake.add(FRAME_PATH, "/panel", node(PANEL, "panel", 400, 300));
    fake.add_on(
        ":1.7",
        Some("/panel"),
        "/remote",
        node(PUSH_BUTTON, "Remote", 50, 20),
    );
    fake
}

#[test]
fn a_retained_ref_refuses_the_same_path_and_rectangle_on_another_owner() {
    let mut fake = Fake::new();
    fake.add(
        FRAME_PATH,
        "/field",
        node(crate::tree::vocabulary::role_numbers::ENTRY, "", 100, 24),
    );
    let mut entry = fake.entry_of("/field", true);
    let original = resolve(&mut fake, &entry, deadline()).expect("original field");
    entry.identity.retained_object = fake
        .evidence(&original)
        .unwrap()
        .identifiers
        .retained_object()
        .map(str::to_owned);
    assert!(entry.identity.retained_object.is_some());
    assert_eq!(
        resolve(&mut fake, &entry, deadline()).unwrap().bus_name(),
        BUS
    );
    fake.pids.insert(":1.99".to_owned(), 99);
    fake.nodes.get_mut("/field").unwrap().bus = ":1.99".to_owned();
    let error = resolve(&mut fake, &entry, deadline()).expect_err("replacement owner");
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn an_element_under_a_child_on_another_bus_name_keeps_the_frames_process_beside_its_own() {
    let mut fake = remote_panel();
    let entry = fake.entry_of("/remote", true);
    assert_eq!(entry.process.pid.get(), WINDOW_PID);
    let found = resolve(&mut fake, &entry, deadline()).expect("resolves");
    assert_eq!(found.bus_name(), ":1.7");
    assert_eq!(found.pid(), 41);
    assert_eq!(found.frame().map(|frame| frame.pid()), Some(WINDOW_PID));
    assert_eq!(found.frame().map(|frame| frame.bus_name()), Some(BUS));
}

#[test]
fn a_disappearing_renderer_is_not_reported_as_the_live_frame_owner_leaving() {
    for resolver in [
        resolve::<Fake>,
        crate::tree::resolve::resolve_anchor::resolve_anchor::<Fake>,
    ] {
        for during_descent in [false, true] {
            let mut fake = remote_panel();
            fake.add_on(
                ":1.7",
                Some("/remote"),
                "/target",
                node(PUSH_BUTTON, "Target", 50, 20),
            );
            let entry = fake.entry_of("/target", true);
            let errors = if during_descent {
                &mut fake.faults.level_errors
            } else {
                &mut fake.faults.evidence_errors
            };
            let failed_path = if during_descent { "/remote" } else { "/target" };
            errors.insert(
                failed_path.to_owned(),
                AdapterError::new(ErrorCode::AppNotFound, "renderer left"),
            );
            let error = resolver(&mut fake, &entry, deadline()).expect_err("renderer is gone");
            assert_eq!(error.code, ErrorCode::StaleRef);
            let details = error.details.as_ref().expect("departure cause");
            assert_eq!(details["kind"], "resolve_descendant_owner_gone");
            assert_eq!(details["failed_bus"], ":1.7");
            assert_eq!(details["failed_pid"], 41);
            assert_eq!(details["failed_path"], failed_path);
            assert_eq!(details["complete"], false);
            assert!(error.is_explicitly_retryable());
            assert_eq!(error.platform_detail.as_deref(), Some("renderer left"));
            assert_eq!(fake.reads.gate, 2, "the stored frame owner is rechecked");
        }
    }
}

#[test]
fn a_frame_owner_lost_during_renderer_failure_keeps_the_frame_gate_cause() {
    let mut fake = remote_panel();
    let entry = fake.entry_of("/remote", true);
    fake.faults.evidence_errors.insert(
        "/remote".to_owned(),
        AdapterError::new(ErrorCode::AppNotFound, "renderer left"),
    );
    fake.faults.recheck_error = Some(crate::tree::resolve::resolve_errors::app_exited());
    let error = resolve(&mut fake, &entry, deadline()).expect_err("frame owner also left");
    assert_eq!(
        error.details.as_ref().expect("frame cause")["kind"],
        "resolve_owning_process_exited"
    );
    assert!(!error.is_explicitly_retryable());
    assert_eq!(fake.reads.gate, 2);
}

#[test]
fn a_child_whose_owner_cannot_be_looked_up_stays_incomplete() {
    let mut fake = remote_panel();
    let with_path = fake.entry_of("/remote", true);
    let mut without_path = with_path.clone();
    without_path.scope.path.clear();
    fake.pids.remove(":1.7");
    for entry in [with_path, without_path] {
        let error = resolve(&mut fake, &entry, deadline()).expect_err("unreadable");
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert!(error.is_explicitly_retryable());
        assert!(is_incomplete(&error));
        assert_eq!(error.details.as_ref().expect("details")["complete"], false);
    }
}

fn window_with_background_tab() -> Fake {
    let mut fake = Fake::new();
    fake.web_process = true;
    fake.add(FRAME_PATH, "/tab", node(DOCUMENT_WEB, "", 800, 500));
    fake.add(FRAME_PATH, "/save", node(PUSH_BUTTON, "Save", 60, 24));
    fake
}

#[test]
fn the_window_frame_resolves_though_a_background_tab_document_lists_no_children() {
    let mut fake = window_with_background_tab();
    let entry = fake.entry_of(FRAME_PATH, true);
    assert!(entry.scope.path.is_empty());
    let found = resolve(&mut fake, &entry, deadline()).expect("the frame resolves");
    assert_eq!(found.path(), FRAME_PATH);
    assert_eq!(fake.reads.searches, 1);
}

#[test]
fn a_pathless_element_stays_retried_while_a_web_document_lists_no_children() {
    let mut fake = window_with_background_tab();
    let mut entry = fake.entry_of("/save", true);
    entry.scope.path.clear();
    let error = resolve(&mut fake, &entry, deadline()).expect_err("a region is unread");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert!(error.is_explicitly_retryable());
    assert!(is_incomplete(&error));
    assert_eq!(error.details.as_ref().expect("details")["complete"], false);
}
