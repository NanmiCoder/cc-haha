use crate::tree::live::test_support::read_of;
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;
use crate::tree::{Extents, Field, ObservedRead};

use super::evidence_of;

fn placed(read: ObservedRead, bounds: (i32, i32, i32, i32)) -> ObservedRead {
    let mut read = read;
    read.evidence_bounds = Some((
        Extents {
            x: bounds.0,
            y: bounds.1,
            width: bounds.2,
            height: bounds.3,
        },
        agent_desktop_core::BoundsSpace::Window,
    ));
    read
}

#[test]
fn a_named_node_keeps_its_name_and_never_borrows_the_object_path_as_identity() {
    let evidence = evidence_of(placed(read_of(PUSH_BUTTON, "Save", &[]), (4, 8, 120, 24)));

    assert_eq!(evidence.identifiers.preferred_identifier(), None);
    assert_eq!(evidence.identifiers.retained_object(), None);
}

#[test]
fn an_identityless_node_with_a_rectangle_retains_its_bus_and_object_path() {
    let read = placed(read_of(PUSH_BUTTON, "", &[]), (4, 8, 120, 24));
    let path = ":1.1/p";
    let evidence = evidence_of(read);

    assert_eq!(evidence.identifiers.retained_object(), Some(path));
}

#[test]
fn an_identityless_node_without_an_area_still_retains_its_bus_and_object_path() {
    let mut read = placed(read_of(PUSH_BUTTON, "", &[]), (4, 8, 0, 24));
    read.node.extents = Field::Absent;
    let path = ":1.1/p";
    let evidence = evidence_of(read);

    assert_eq!(evidence.identifiers.retained_object(), Some(path));
}

#[test]
fn a_node_whose_identity_read_failed_stores_no_retained_object() {
    let mut read = placed(read_of(PUSH_BUTTON, "", &[]), (4, 8, 120, 24));
    read.node.properties.name = Field::Failed("name unreadable".to_owned());
    let evidence = evidence_of(read);

    assert_eq!(evidence.identifiers.retained_object(), None);
}
