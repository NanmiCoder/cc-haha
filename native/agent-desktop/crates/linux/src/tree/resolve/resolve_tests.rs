use agent_desktop_core::{Deadline, ErrorCode};

use super::*;
use crate::tree::live::test_support::rect;
use crate::tree::resolve::resolve_fake::{FRAME_PATH, Fake, deadline, node};
use crate::tree::vocabulary::role_numbers::{PANEL, PUSH_BUTTON};
use crate::tree::{Extents, Field};

fn files() -> Fake {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/toolbar", node(PANEL, "toolbar", 800, 40));
    fake.add(
        "/toolbar",
        "/opts1",
        node(PUSH_BUTTON, "View Options", 34, 34),
    );
    fake.add(
        "/toolbar",
        "/opts2",
        node(PUSH_BUTTON, "View Options", 23, 34),
    );
    fake.add(FRAME_PATH, "/back", node(PUSH_BUTTON, "Back", 30, 30));
    fake
}

fn resolved(fake: &mut Fake, entry: &agent_desktop_core::RefEntry) -> String {
    resolve(fake, entry, deadline())
        .expect("the ref resolves")
        .path()
        .to_owned()
}

fn refusal(fake: &mut Fake, entry: &agent_desktop_core::RefEntry) -> AdapterError {
    resolve(fake, entry, deadline()).expect_err("the ref is refused")
}

fn kind(error: &AdapterError) -> &str {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
}

#[test]
fn the_search_separates_the_second_twin_by_stored_size() {
    let mut fake = files();
    let entry = fake.entry_of("/opts2", true);
    assert_eq!(entry.scope.path.as_slice(), [0, 1]);
    assert_eq!(resolved(&mut fake, &entry), "/opts2");
    assert_eq!(fake.reads.searches, 1);
    assert_eq!(fake.reads.levels, 2);
    assert_eq!(fake.reads.evidence, 1);
}

#[test]
fn a_ref_with_no_stored_size_cannot_distinguish_its_twin() {
    let mut fake = files();
    let entry = fake.entry_of("/opts2", false);
    assert!(entry.geometry.bounds.is_none());
    assert_eq!(refusal(&mut fake, &entry).code, ErrorCode::AmbiguousTarget);
    assert_eq!(fake.reads.searches, 1);
}

#[test]
fn moved_screen_geometry_cannot_separate_twins_until_refreshed() {
    let mut fake = files();
    let entry = fake.entry_of("/opts2", true);
    fake.shift_every_position(120, 64);
    assert_eq!(refusal(&mut fake, &entry).code, ErrorCode::AmbiguousTarget);
    assert_eq!(fake.reads.searches, 1);

    let mut without_path = fake.entry_of("/opts2", true);
    without_path.scope.path.clear();
    assert_eq!(resolved(&mut fake, &without_path), "/opts2");
    assert_eq!(fake.reads.searches, 2);
}

#[test]
fn twins_the_path_cannot_separate_are_ambiguous_without_a_size_that_does() {
    let mut fake = files();
    let mut entry = fake.entry_of("/opts2", false);
    entry.scope.path.clear();
    let none = refusal(&mut fake, &entry);
    assert_eq!(none.code, ErrorCode::AmbiguousTarget);
    assert_eq!(kind(&none), "resolve_ambiguous");
    assert!(!none.is_explicitly_retryable());
    assert_eq!(
        none.details.as_ref().expect("details")["candidate_count"],
        2
    );

    let mut elsewhere = fake.entry_of("/opts2", true);
    elsewhere.scope.path.clear();
    elsewhere.geometry.bounds = Some(rect(0.0, 0.0, 99.0, 34.0));
    assert_eq!(
        refusal(&mut fake, &elsewhere).code,
        ErrorCode::AmbiguousTarget
    );
}

#[test]
fn a_path_that_lands_on_something_else_is_declined_and_the_search_decides() {
    let mut fake = files();
    let mut twin = fake.entry_of("/opts2", true);
    twin.scope.path = [0, 0].into_iter().collect();
    assert_eq!(resolved(&mut fake, &twin), "/opts2");
    assert_eq!(fake.reads.searches, 1);

    let mut back = fake.entry_of("/back", true);
    back.scope.path = [0, 0].into_iter().collect();
    assert_eq!(resolved(&mut fake, &back), "/back");
}

#[test]
fn a_landing_whose_size_contradicts_the_stored_one_is_declined_even_when_its_name_matches() {
    let mut fake = files();
    let mut entry = fake.entry_of("/opts1", true);
    entry.scope.path = [0, 1].into_iter().collect();
    assert_eq!(resolved(&mut fake, &entry), "/opts1");
    assert_eq!(fake.reads.searches, 1);
}

#[test]
fn a_page_that_left_the_tree_is_stale_and_its_stored_path_is_never_read_directly() {
    let mut fake = files();
    let entry = fake.entry_of("/opts2", true);
    fake.nodes
        .get_mut(FRAME_PATH)
        .expect("frame")
        .children
        .retain(|path| path != "/toolbar");
    let error = refusal(&mut fake, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind(&error), "resolve_no_candidate");
    assert!(error.is_explicitly_retryable());
    assert_eq!(fake.reads.evidence, 0);
}

#[test]
fn a_unique_match_resolves_and_no_match_is_stale_only_when_everything_was_read() {
    let mut fake = files();
    let mut back = fake.entry_of("/back", true);
    back.scope.path.clear();
    assert_eq!(resolved(&mut fake, &back), "/back");

    fake.nodes
        .get_mut("/back")
        .expect("back")
        .read
        .node
        .properties
        .name = crate::tree::Field::Present("Close".to_owned());
    let stale = refusal(&mut fake, &back);
    assert_eq!(kind(&stale), "resolve_no_candidate");

    fake.nodes
        .get_mut("/toolbar")
        .expect("toolbar")
        .children_unread = true;
    let incomplete = refusal(&mut fake, &back);
    assert_eq!(incomplete.code, ErrorCode::StaleRef);
    assert!(incomplete.is_explicitly_retryable());
}

#[test]
fn one_match_beside_an_unread_region_is_retried_and_not_resolved() {
    let mut fake = files();
    let mut back = fake.entry_of("/back", true);
    back.scope.path.clear();
    fake.nodes
        .get_mut("/toolbar")
        .expect("toolbar")
        .children_unread = true;
    let error = refusal(&mut fake, &back);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert!(error.is_explicitly_retryable());
    assert!(is_incomplete(&error));
    assert_eq!(error.details.as_ref().expect("details")["complete"], false);
}

#[test]
fn a_childless_web_frame_keeps_an_incomplete_retryable_ref() {
    let source = files();
    let with_path = source.entry_of("/back", true);
    let mut without_path = with_path.clone();
    without_path.scope.path.clear();
    for entry in [with_path, without_path] {
        let mut cold = Fake::new();
        cold.web_process = true;
        let error = refusal(&mut cold, &entry);
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert!(error.is_explicitly_retryable());
        assert!(is_incomplete(&error));
        assert_eq!(error.details.as_ref().expect("details")["complete"], false);
    }
}

#[test]
fn a_drill_down_ref_with_a_relative_path_skips_the_path_tier() {
    let mut fake = files();
    let mut entry = fake.entry_of("/back", true);
    entry.scope.root_ref = Some("@s1:e3".to_owned());
    entry.scope.path_is_absolute = false;
    assert_eq!(resolved(&mut fake, &entry), "/back");
    assert_eq!(fake.reads.levels, 0);
    assert_eq!(fake.reads.searches, 1);
}

#[test]
fn a_deadline_that_is_already_spent_is_a_timeout_before_any_read() {
    let mut fake = files();
    let entry = fake.entry_of("/back", true);
    let spent = Deadline::after(0).expect("a zero deadline builds");
    let error = resolve(&mut fake, &entry, spent).expect_err("spent");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(fake.reads.gate, 0);
}

#[test]
fn a_nameless_ref_whose_element_changed_size_is_a_retryable_miss() {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/editor", node(PANEL, "", 690, 464));
    let entry = fake.entry_of("/editor", true);
    assert!(entry.identity.name.is_none());
    fake.nodes
        .get_mut("/editor")
        .expect("editor")
        .read
        .node
        .extents = crate::tree::Field::Present(crate::tree::Extents {
        x: 0,
        y: 0,
        width: 690,
        height: 440,
    });
    let error = refusal(&mut fake, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind(&error), "resolve_no_candidate");
    assert!(error.is_explicitly_retryable());
}

#[test]
fn a_geometry_only_ref_refuses_even_a_one_pixel_resize() {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/editor", node(PANEL, "", 690, 464));
    let entry = fake.entry_of("/editor", true);
    fake.nodes
        .get_mut("/editor")
        .expect("editor")
        .read
        .node
        .extents = crate::tree::Field::Present(crate::tree::Extents {
        x: 0,
        y: 1,
        width: 690,
        height: 463,
    });
    let error = refusal(&mut fake, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind(&error), "resolve_no_candidate");
}

#[test]
fn a_twin_whose_extents_cannot_be_read_is_never_replaced_by_the_twin_of_its_size() {
    let mut fake = files();
    let mut entry = fake.entry_of("/opts2", true);
    entry.scope.path.clear();
    fake.nodes
        .get_mut("/opts1")
        .expect("opts1")
        .read
        .node
        .extents = crate::tree::Field::Present(crate::tree::Extents {
        x: 0,
        y: 0,
        width: 23,
        height: 34,
    });
    fake.nodes
        .get_mut("/opts2")
        .expect("opts2")
        .read
        .node
        .extents = crate::tree::Field::Failed("extents unavailable".to_owned());
    let error = refusal(&mut fake, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert!(error.is_explicitly_retryable());
    assert!(is_incomplete(&error));
    assert_eq!(error.details.as_ref().expect("details")["complete"], false);
}

#[test]
fn a_destroyed_landing_declines_settled_and_any_other_failed_read_leaves_the_region_unread() {
    let mut fake = files();
    let entry = fake.entry_of("/opts2", true);
    let frame = fake.frame();
    fake.faults.evidence_errors.insert(
        "/opts2".to_owned(),
        AdapterError::new(ErrorCode::ElementNotFound, "destroyed"),
    );
    let unread = path_tier(&mut fake, &frame, &entry, deadline()).expect("declines");
    assert!(!unread);

    fake.faults.evidence_errors.insert(
        "/opts2".to_owned(),
        AdapterError::new(ErrorCode::Internal, "unreadable"),
    );
    let unread = path_tier(&mut fake, &frame, &entry, deadline()).expect("declines");
    assert!(unread);
}

#[test]
fn geometry_requires_the_recorded_frame_and_position() {
    use agent_desktop_core::BoundsSpace::{Screen, Window};

    for named in [true, false] {
        for (stored_space, live_window, shifted, resolves) in [
            (Some(Screen), false, false, true),
            (Some(Screen), false, true, false),
            (Some(Window), false, false, false),
            (Some(Window), true, false, true),
            (Some(Window), true, true, false),
            (None, false, false, true),
            (None, false, true, false),
        ] {
            let mut fake = Fake::new();
            let name = if named { "target" } else { "" };
            fake.add(FRAME_PATH, "/first", node(PUSH_BUTTON, name, 80, 20));
            fake.add(FRAME_PATH, "/second", node(PUSH_BUTTON, name, 140, 20));
            let mut entry = fake.entry_of("/first", true);
            entry.geometry.bounds_space = stored_space;
            for path in ["/first", "/second"] {
                let read = &mut fake.nodes.get_mut(path).expect("candidate").read;
                let mut bounds = *read.node.extents.present().expect("rectangle");
                bounds.x += if shifted { 100 } else { 0 };
                read.node.extents = crate::tree::Field::Present(bounds);
                if live_window {
                    read.evidence_bounds = Some((bounds, Window));
                }
            }
            let result = resolve(&mut fake, &entry, deadline());
            if resolves {
                assert_eq!(result.expect("same recorded rectangle").path(), "/first");
            } else {
                let expected = if named {
                    ErrorCode::AmbiguousTarget
                } else {
                    ErrorCode::StaleRef
                };
                assert_eq!(
                    result.expect_err("unproven geometry must refuse").code,
                    expected,
                    "{named:?} {stored_space:?} {live_window} {shifted}"
                );
            }
        }
    }
}

#[test]
fn twins_with_both_coordinate_frames_use_the_refs_recorded_frame() {
    use agent_desktop_core::BoundsSpace;
    let mut fake = Fake::new();
    for (path, x) in [("/first", 10), ("/second", 40)] {
        let mut read = node(PUSH_BUTTON, "Same", 23, 34);
        read.node.extents = Field::Present(Extents {
            x,
            y: 10,
            width: 23,
            height: 34,
        });
        read.evidence_bounds = Some((
            Extents {
                x: x - 10,
                y: 0,
                width: 23,
                height: 34,
            },
            BoundsSpace::Window,
        ));
        fake.add(FRAME_PATH, path, read);
    }
    let mut entry = fake.entry_of("/first", false);
    entry.scope.path.clear();
    entry.geometry.bounds = Some(rect(10.0, 10.0, 23.0, 34.0));
    entry.geometry.bounds_space = Some(BoundsSpace::Screen);
    assert_eq!(
        resolve(&mut fake, &entry, deadline()).unwrap().path(),
        "/first"
    );
    entry.geometry.bounds = Some(rect(90.0, 10.0, 23.0, 34.0));
    assert_eq!(
        resolve(&mut fake, &entry, deadline()).unwrap_err().code,
        ErrorCode::AmbiguousTarget
    );
}
