use super::imp::{
    HitClassification, ax_point, classify_relation, ends_clipping_walk, intersect_rects,
    needs_application_retry, remember_ancestor,
};
use crate::tree::AXElement;
use accessibility_sys::AXUIElementCreateSystemWide;
use agent_desktop_core::{Point, Rect};

#[test]
fn self_hit_reaches_target() {
    assert_eq!(
        classify_relation(true, false),
        HitClassification::ReachesTarget
    );
}

#[test]
fn reaches_target_takes_priority_over_ancestor() {
    assert_eq!(
        classify_relation(true, true),
        HitClassification::ReachesTarget
    );
}

#[test]
fn ancestor_hit_is_reported_separately_from_unrelated() {
    assert_eq!(
        classify_relation(false, true),
        HitClassification::AncestorOfTarget
    );
}

#[test]
fn unrelated_hit_is_neither_target_nor_ancestor() {
    assert_eq!(
        classify_relation(false, false),
        HitClassification::Unrelated
    );
}

#[test]
fn target_ancestor_hit_retries_in_application_scope() {
    assert!(needs_application_retry(HitClassification::AncestorOfTarget));
    assert!(!needs_application_retry(HitClassification::ReachesTarget));
    assert!(!needs_application_retry(HitClassification::Unrelated));
}

#[test]
fn external_display_point_stays_in_global_top_left_coordinates() {
    assert_eq!(
        ax_point(&Point {
            x: 2065.0,
            y: 636.0,
        }),
        (2065.0, 636.0)
    );
}

#[test]
fn application_root_completes_the_clipping_walk_without_a_parent() {
    assert!(ends_clipping_walk(Some("AXApplication")));
    assert!(!ends_clipping_walk(Some("AXGroup")));
    assert!(!ends_clipping_walk(None));
}

#[test]
fn clipped_bounds_keep_only_the_visible_part_of_a_partially_shown_target() {
    let target = Rect {
        x: 100.0,
        y: 900.0,
        width: 220.0,
        height: 160.0,
    };
    let viewport = Rect {
        x: 0.0,
        y: 0.0,
        width: 1000.0,
        height: 950.0,
    };

    assert_eq!(
        intersect_rects(target, viewport),
        Some(Rect {
            x: 100.0,
            y: 900.0,
            width: 220.0,
            height: 50.0,
        })
    );
}

#[test]
fn ancestor_walk_retains_handles_and_detects_the_same_element() {
    let system = AXElement(unsafe { AXUIElementCreateSystemWide() });
    let equivalent = AXElement(unsafe { AXUIElementCreateSystemWide() });
    let mut visited = Vec::new();

    assert!(remember_ancestor(&mut visited, &system));
    assert!(!remember_ancestor(&mut visited, &equivalent));
    assert_eq!(visited.len(), 1);
}
