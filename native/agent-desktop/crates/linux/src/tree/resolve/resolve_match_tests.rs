use agent_desktop_core::{IdentifierEvidence, LocatorField};

use super::*;
use crate::tree::live::test_support::{evidence, rect, ref_entry, with_identifier};

fn named(role: &str, name: &str) -> RefEntry {
    let mut entry = ref_entry(role);
    entry.identity.name = Some(name.to_owned());
    entry
}

fn sized(mut entry: RefEntry, bounds: Rect) -> RefEntry {
    entry.geometry.bounds = Some(bounds);
    entry.geometry.bounds_hash = bounds.bounds_hash();
    entry
}

#[test]
fn an_unreadable_role_withholds_the_verdict_and_a_different_role_is_rejected() {
    let entry = named("button", "Save");
    let mut unread = evidence("button", Some("Save"), None, None);
    unread.role = LocatorField::Unknown;
    assert_eq!(admit_node(&entry, &unread), Admission::Unread);

    let other = evidence("link", Some("Save"), None, None);
    assert_eq!(admit_node(&entry, &other), Admission::Reject);

    let same = evidence("button", Some("Save"), None, None);
    assert_eq!(admit_node(&entry, &same), Admission::Collect);
}

#[test]
fn an_identifier_match_with_no_stored_text_resolves_on_the_identifier_alone() {
    let entry = with_identifier(ref_entry("button"), "toolbar.save");
    let live = evidence("button", Some("anything"), Some("toolbar.save"), None);
    assert_eq!(admit_node(&entry, &live), Admission::Collect);
}

#[test]
fn an_identifier_read_that_was_incomplete_is_unread_and_never_a_refutation() {
    let entry = with_identifier(named("button", "Save"), "toolbar.save");
    let mut live = evidence("button", Some("Save"), None, None);
    live.identifiers = IdentifierEvidence::typed([], None, false);
    assert_eq!(admit_node(&entry, &live), Admission::Unread);
}

#[test]
fn an_identifier_match_whose_stored_text_cannot_be_read_is_unread() {
    let entry = with_identifier(named("button", "Save"), "toolbar.save");
    let mut live = evidence("button", None, Some("toolbar.save"), None);
    live.name = LocatorField::Unknown;
    assert_eq!(admit_node(&entry, &live), Admission::Unread);
}

#[test]
fn unknown_or_unusable_rectangles_cannot_refute_geometry() {
    let entry = sized(
        named("button", "View Options"),
        rect(10.0, 10.0, 34.0, 34.0),
    );
    let unreadable = {
        let mut live = evidence("button", Some("View Options"), None, None);
        live.ref_evidence.bounds = LocatorField::Unknown;
        live
    };
    let no_extents = evidence("button", Some("View Options"), None, None);
    let minus_one = evidence(
        "button",
        Some("View Options"),
        None,
        Some(rect(-1.0, -1.0, -1.0, -1.0)),
    );
    assert!(!geometry_contradicts(&entry, &unreadable));
    assert!(!geometry_contradicts(&entry, &no_extents));
    assert!(!geometry_contradicts(&entry, &minus_one));
}

#[test]
fn missing_or_empty_stored_rectangles_cannot_refute_geometry() {
    let live = evidence(
        "button",
        Some("View Options"),
        None,
        Some(rect(0.0, 0.0, 23.0, 34.0)),
    );
    assert!(!geometry_contradicts(
        &named("button", "View Options"),
        &live
    ));
    let flat = sized(named("button", "View Options"), rect(0.0, 0.0, 34.0, 0.0));
    assert!(!geometry_contradicts(&flat, &live));
}

#[test]
fn an_unreadable_identity_needs_the_whole_recorded_rectangle() {
    let entry = sized(ref_entry("entry"), rect(5.0, 5.0, 120.0, 24.0));
    let same = evidence("entry", None, None, Some(rect(5.0, 5.0, 120.0, 24.0)));
    let other = evidence("entry", None, None, Some(rect(900.0, 9.0, 120.0, 24.0)));
    let mut unreadable_same = same.clone();
    unreadable_same.name = LocatorField::Unknown;
    let mut unreadable_other = other.clone();
    unreadable_other.name = LocatorField::Unknown;
    assert_eq!(admit_node(&entry, &unreadable_same), Admission::Collect);
    assert_eq!(admit_node(&entry, &unreadable_other), Admission::Reject);
}

#[test]
fn a_geometry_only_ref_needs_known_matching_position_and_size() {
    let entry = sized(ref_entry("textfield"), rect(0.0, 0.0, 690.0, 464.0));
    let mut resized = evidence("textfield", None, None, Some(rect(0.0, 0.0, 690.0, 463.0)));
    assert_eq!(admit_node(&entry, &resized), Admission::Reject);
    let same = evidence("textfield", None, None, Some(rect(0.0, 0.0, 690.0, 464.0)));
    assert_eq!(admit_node(&entry, &same), Admission::Collect);
    resized.ref_evidence.bounds = LocatorField::Unknown;
    assert_eq!(admit_node(&entry, &resized), Admission::Unread);
    resized.ref_evidence.bounds = LocatorField::Absent;
    assert_eq!(admit_node(&entry, &resized), Admission::Reject);
}

#[test]
fn any_rectangle_drift_refuses_a_geometry_only_candidate() {
    let entry = sized(ref_entry("textfield"), rect(290.0, 186.0, 690.0, 464.0));
    for bounds in [
        rect(290.0, 186.0, 690.0, 464.0),
        rect(290.0, 187.0, 690.0, 463.0),
        rect(290.25, 186.0, 690.0, 464.0),
        rect(290.0, 186.25, 690.0, 464.0),
        rect(290.0, 186.0, 690.25, 464.0),
        rect(290.0, 186.0, 690.0, 464.25),
    ] {
        let live = evidence("textfield", None, None, Some(bounds));
        let expected = if bounds == entry.geometry.bounds.expect("stored rectangle") {
            Admission::Collect
        } else {
            Admission::Reject
        };
        assert_eq!(admit_node(&entry, &live), expected, "{bounds:?}");
    }
}

fn retained_at(path: &str, bounds: Rect) -> RefEntry {
    let mut entry = sized(ref_entry("button"), bounds);
    entry.geometry.bounds_space = Some(agent_desktop_core::BoundsSpace::Window);
    entry.identity.retained_object = Some(path.to_owned());
    entry
}

fn retained_evidence(path: &str, bounds: Rect) -> LocatorEvidence {
    let mut found = evidence("button", None, None, None);
    found.identifiers = found.identifiers.with_retained_object(path.to_owned());
    found.ref_evidence.window_bounds = LocatorField::Known(bounds);
    found
}

#[test]
fn a_retained_object_is_refuted_by_a_different_rectangle_at_the_same_path() {
    let entry = retained_at("/row", rect(0.0, 38.0, 420.0, 34.0));
    let moved = retained_evidence("/row", rect(0.0, 80.0, 420.0, 34.0));
    assert_eq!(admit_node(&entry, &moved), Admission::Reject);

    let same = retained_evidence("/row", rect(0.0, 38.0, 420.0, 34.0));
    assert_eq!(admit_node(&entry, &same), Admission::Collect);
}

#[test]
fn unread_window_geometry_is_not_refuted_by_known_screen_bounds() {
    let mut entry = sized(ref_entry("textfield"), rect(0.0, 0.0, 80.0, 20.0));
    entry.geometry.bounds_space = Some(BoundsSpace::Window);
    let mut live = evidence(
        "textfield",
        None,
        None,
        Some(rect(500.0, 500.0, 80.0, 20.0)),
    );
    live.ref_evidence.window_bounds = LocatorField::Unknown;
    assert_eq!(admit_node(&entry, &live), Admission::Unread);
    live.ref_evidence.window_bounds = LocatorField::Known(rect(0.0, 0.0, 80.0, 20.0));
    assert_eq!(admit_node(&entry, &live), Admission::Collect);
    live.ref_evidence.window_bounds = LocatorField::Known(rect(0.0, 1.0, 80.0, 20.0));
    assert_eq!(admit_node(&entry, &live), Admission::Reject);
}
