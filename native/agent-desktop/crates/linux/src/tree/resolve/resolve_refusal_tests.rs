use agent_desktop_core::{AdapterError, ErrorCode};

use super::*;
use crate::tree::Field;
use crate::tree::live::test_support::{rect, ref_entry};
use crate::tree::resolve::resolve_errors::{app_exited, window_replaced};
use crate::tree::resolve::resolve_fake::{FRAME_PATH, Fake, deadline, node};
use crate::tree::vocabulary::role_numbers::{LIST, PUSH_BUTTON};

fn one_button() -> Fake {
    let mut fake = Fake::new();
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

fn no_reads(fake: &Fake) {
    assert_eq!(fake.reads.levels, 0);
    assert_eq!(fake.reads.evidence, 0);
    assert_eq!(fake.reads.searches, 0);
}

#[test]
fn a_ref_with_nothing_to_match_is_refused_before_any_read_of_any_kind() {
    let mut fake = one_button();
    let mut entry = ref_entry("group");
    entry.geometry.bounds = Some(rect(0.0, 0.0, 710.0, 0.0));
    let error = resolve(&mut fake, &entry, deadline()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind(&error), "resolve_unverifiable_entry");
    assert_eq!(fake.reads.gate, 0);
    no_reads(&fake);
}

#[test]
fn a_destroyed_or_replaced_window_is_terminal_before_any_target_reads() {
    for (refusal, expected) in [
        (window_replaced(), "resolve_window_replaced"),
        (app_exited(), "resolve_owning_process_exited"),
        (
            AdapterError::new(
                ErrorCode::ElementNotFound,
                "the stored window was destroyed",
            ),
            "resolve_target_destroyed",
        ),
    ] {
        let mut fake = one_button();
        let entry = fake.entry_of("/back", true);
        fake.faults.gate_error = Some(refusal);
        let error = resolve(&mut fake, &entry, deadline()).expect_err("refused");
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(kind(&error), expected);
        assert!(!error.is_explicitly_retryable());
        assert!(!error.permits_retry_by_default());
        assert_eq!(
            error.disposition,
            agent_desktop_core::DeliverySemantics::not_delivered()
        );
        assert_eq!(fake.reads.gate, 1);
        no_reads(&fake);
    }
}

#[test]
fn an_owner_unreachable_on_this_bus_is_refused_without_claiming_it_exited() {
    let mut fake = one_button();
    let mut entry = fake.entry_of("/back", true);
    entry.process.pid = std::process::id().into();
    fake.faults.gate_error = Some(AdapterError::new(ErrorCode::AppNotFound, "left"));
    let error = resolve(&mut fake, &entry, deadline()).expect_err("gone");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind(&error), "resolve_owner_unreachable");
    assert_eq!(
        error.message,
        "Stored ref's owning application is not reachable on this session's accessibility bus"
    );
    assert_eq!(
        error.suggestion.as_deref(),
        Some(
            "Return to the desktop session where this ref was captured, run 'snapshot', then retry with the new ref."
        )
    );
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert!(!error.is_explicitly_retryable());
    assert_eq!(fake.reads.gate, 1);
    no_reads(&fake);
}

#[test]
fn a_search_timeout_is_never_stale() {
    let mut fake = one_button();
    let mut entry = fake.entry_of("/back", true);
    entry.scope.path.clear();
    fake.faults.search_error = Some(AdapterError::timeout("slow"));
    let slow = resolve(&mut fake, &entry, deadline()).expect_err("timeout");
    assert_eq!(slow.code, ErrorCode::Timeout);
}

#[test]
fn a_candidate_vanishing_during_search_does_not_make_its_answering_app_unresponsive() {
    let mut fake = one_button();
    let mut entry = fake.entry_of("/back", true);
    entry.scope.path.clear();
    let candidate = fake.nodes.get_mut("/back").expect("snapshot candidate");
    candidate.read = crate::tree::ObservedRead::unreadable(
        candidate.read.node.element.clone(),
        "The accessible object no longer exists",
    );
    let error = resolve(&mut fake, &entry, deadline()).expect_err("vanished candidate");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        error.details.as_ref().expect("incomplete evidence")["complete"],
        false
    );
    assert!(error.is_explicitly_retryable());
    fake.stopped = Some("files".into());
    let error = resolve(&mut fake, &entry, deadline()).expect_err("stopped twin");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}

#[test]
fn a_stopped_process_is_unresponsive_before_anything_is_read_or_waited_for() {
    let mut fake = one_button();
    let entry = fake.entry_of("/back", true);
    fake.stopped = Some("files".to_owned());
    let error = resolve(&mut fake, &entry, deadline()).expect_err("stopped");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    no_reads(&fake);
}

fn bare_list() -> Fake {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/list", node(LIST, "", 100, 0));
    fake.add(FRAME_PATH, "/back", node(PUSH_BUTTON, "Back", 30, 30));
    fake
}

#[test]
fn a_bare_ref_never_retargets_a_reordered_or_replaced_same_role_sibling() {
    for replacement in [false, true] {
        let mut fake = bare_list();
        fake.add(FRAME_PATH, "/twin", node(LIST, "", 100, 0));
        let entry = fake.entry_of("/list", false);
        let children = &mut fake.nodes.get_mut(FRAME_PATH).expect("frame").children;
        if replacement {
            children[0] = "/twin".to_owned();
            children.pop();
        } else {
            children.swap(0, 2);
        }
        let error = resolve(&mut fake, &entry, deadline()).expect_err("no identity anchor");
        assert_eq!(error.code, ErrorCode::StaleRef);
        no_reads(&fake);
    }
}

#[test]
fn indistinguishable_sized_twins_remain_ambiguous_after_the_path_declines() {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/first", node(LIST, "", 100, 40));
    fake.add(FRAME_PATH, "/second", node(LIST, "", 100, 40));
    let mut entry = fake.entry_of("/first", true);
    entry.scope.path = [99].into_iter().collect();
    let error = resolve(&mut fake, &entry, deadline()).expect_err("twins are ambiguous");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(
        error.details.as_ref().expect("details")["candidate_count"],
        2
    );
}

fn window_field(x: i32, y: i32, width: i32, height: i32) -> crate::tree::ObservedRead {
    let mut read = node(LIST, "", width, height);
    read.node.extents = crate::tree::Field::Present(crate::tree::Extents {
        x,
        y,
        width,
        height,
    });
    read.evidence_bounds = Some((
        crate::tree::Extents {
            x,
            y,
            width,
            height,
        },
        agent_desktop_core::BoundsSpace::Window,
    ));
    read
}

#[test]
fn a_known_absent_rectangle_separates_twins_but_an_unread_rectangle_does_not() {
    for (unread, keep_rectangle) in [(false, true), (true, true), (false, false), (true, false)] {
        let mut fake = Fake::new();
        fake.add(FRAME_PATH, "/visible", node(PUSH_BUTTON, "Name", 378, 46));
        let mut entry = fake.entry_of("/visible", true);
        if !keep_rectangle {
            entry.geometry.bounds = None;
        }
        let mut hidden = node(PUSH_BUTTON, "Name", 1, 1);
        hidden.node.extents = if unread {
            Field::Failed("unread rectangle".into())
        } else {
            Field::Present(crate::tree::Extents {
                x: i32::MIN,
                y: i32::MIN,
                width: 1,
                height: 1,
            })
        };
        fake.add(FRAME_PATH, "/hidden", hidden);
        let result = resolve(&mut fake, &entry, deadline());
        if unread {
            assert!(result.is_err(), "an unread twin must prevent delivery");
        } else {
            assert_eq!(
                result.expect("known absent twin geometry").path(),
                "/visible"
            );
        }
    }
}

#[test]
fn a_window_relative_ref_resolves_its_field_after_the_siblings_swap() {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/first", window_field(0, 38, 420, 34));
    fake.add(FRAME_PATH, "/second", window_field(0, 80, 420, 34));
    let entry = fake.entry_of("/first", true);
    assert_eq!(
        entry.geometry.bounds_space,
        Some(agent_desktop_core::BoundsSpace::Window)
    );

    let handle = resolve(&mut fake, &entry, deadline()).expect("the field is anchored");
    assert_eq!(handle.path(), "/first");

    fake.nodes
        .get_mut(FRAME_PATH)
        .expect("frame")
        .children
        .swap(0, 1);
    let handle = resolve(&mut fake, &entry, deadline()).expect("the field moved");
    assert_eq!(handle.path(), "/first");
    assert!(
        fake.reads.searches > 0,
        "the path tier declined the swapped sibling"
    );
}

#[test]
fn a_window_relative_ref_refuses_a_replacement_sibling_of_the_same_size() {
    for window_space in [true, false] {
        let mut fake = Fake::new();
        fake.add(FRAME_PATH, "/first", window_field(0, 38, 420, 34));
        fake.add(FRAME_PATH, "/second", window_field(0, 80, 420, 34));
        let mut entry = fake.entry_of("/first", true);
        entry.scope.path.clear();
        let children = &mut fake.nodes.get_mut(FRAME_PATH).expect("frame").children;
        children.remove(0);
        let replacement = if window_space {
            window_field(0, 200, 420, 34)
        } else {
            node(LIST, "", 420, 34)
        };
        fake.add(FRAME_PATH, "/replacement", replacement);
        let error = resolve(&mut fake, &entry, deadline()).expect_err("the replacement moved");
        assert_eq!(error.code, ErrorCode::StaleRef);
    }
}

#[test]
fn a_retained_object_ref_follows_its_widget_after_the_siblings_swap() {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/first", window_field(0, 38, 420, 34));
    fake.add(FRAME_PATH, "/second", window_field(0, 80, 420, 34));
    let mut entry = fake.entry_of("/first", true);
    entry.identity.retained_object = Some(":1.2/first".to_owned());

    fake.nodes
        .get_mut(FRAME_PATH)
        .expect("frame")
        .children
        .swap(0, 1);
    let handle = resolve(&mut fake, &entry, deadline()).expect("the widget is named by its path");
    assert_eq!(handle.path(), "/first");
    assert!(fake.reads.searches > 0, "the swapped landing was declined");
}

#[test]
fn a_retained_object_ref_is_found_without_following_its_stored_path() {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/first", window_field(0, 38, 420, 34));
    fake.add(FRAME_PATH, "/second", window_field(0, 80, 420, 34));
    let mut entry = fake.entry_of("/second", true);
    entry.identity.retained_object = Some(":1.2/second".to_owned());
    assert_eq!(entry.scope.path.as_slice(), [1]);

    let handle = resolve(&mut fake, &entry, deadline()).expect("the object is found");
    assert_eq!(handle.path(), "/second");
    assert_eq!(fake.reads.levels, 0);
    assert_eq!(fake.reads.searches, 1);
}

#[test]
fn a_retained_object_ref_refuses_a_replacement_at_the_old_rectangle() {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/first", window_field(0, 38, 420, 34));
    fake.add(FRAME_PATH, "/second", window_field(0, 80, 420, 34));
    let mut entry = fake.entry_of("/first", true);
    entry.identity.retained_object = Some(":1.2/first".to_owned());

    let children = &mut fake.nodes.get_mut(FRAME_PATH).expect("frame").children;
    children.remove(0);
    fake.add(FRAME_PATH, "/replacement", window_field(0, 38, 420, 34));
    let error = resolve(&mut fake, &entry, deadline()).expect_err("a new object at the old place");
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn a_retained_path_cannot_authorize_a_search_with_an_unread_region() {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/first", window_field(0, 38, 420, 34));
    let mut entry = fake.entry_of("/first", true);
    entry.identity.retained_object = Some(":1.2/first".to_owned());
    assert_eq!(
        resolve(&mut fake, &entry, deadline()).unwrap().path(),
        "/first"
    );
    fake.add(
        FRAME_PATH,
        "/unread",
        node(crate::tree::vocabulary::role_numbers::PANEL, "", 10, 10),
    );
    fake.nodes.get_mut("/unread").unwrap().children_unread = true;
    let error = resolve(&mut fake, &entry, deadline()).unwrap_err();
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert!(error.is_explicitly_retryable());
}
