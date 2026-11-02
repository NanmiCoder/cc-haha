use super::*;
use crate::tree::live::test_support::rect;

fn twins() -> Vec<LocatorField<Rect>> {
    vec![
        LocatorField::Known(rect(391.0, 196.0, 34.0, 34.0)),
        LocatorField::Known(rect(430.0, 196.0, 23.0, 34.0)),
    ]
}

fn geometry(bounds: Rect) -> RefGeometry {
    RefGeometry {
        bounds: Some(bounds),
        bounds_hash: bounds.bounds_hash(),
        bounds_space: None,
    }
}

#[test]
fn a_zero_area_stored_size_cannot_separate_twins() {
    let flat = rect(10.0, 10.0, 34.0, 0.0);
    assert_eq!(
        select_by_stored_geometry(&twins(), &[], &geometry(flat)),
        None
    );
}

#[test]
fn two_matches_with_no_usable_stored_size_are_ambiguous_even_with_an_unread_region() {
    assert_eq!(classify(&twins(), &[], None, true), Verdict::Ambiguous);
}

#[test]
fn a_size_separable_pair_beside_an_unread_region_is_incomplete() {
    let stored = rect(0.0, 0.0, 23.0, 34.0);
    assert_eq!(
        classify(&twins(), &[], Some(&geometry(stored)), true),
        Verdict::Incomplete
    );
}
