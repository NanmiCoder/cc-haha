use super::classify::{PreProbeGuard, point_in_rect, pre_probe_decision, result_for_guard};
use crate::tree::properties::rect_has_area;
use agent_desktop_core::{Point, Rect, adapter::hit_test::HitTestResult};

/// A synthetic screen: the guard ladder is driven with the geometry it would
/// have read, so no assertion here depends on the machine's display layout.
fn screen() -> Rect {
    Rect {
        x: 0.0,
        y: 0.0,
        width: 1_920.0,
        height: 1_080.0,
    }
}

fn on_screen_bounds() -> Rect {
    Rect {
        x: 100.0,
        y: 100.0,
        width: 40.0,
        height: 40.0,
    }
}

fn inside_bounds() -> Point {
    Point { x: 120.0, y: 120.0 }
}

#[test]
fn probeable_geometry_trips_no_guard() {
    assert_eq!(
        pre_probe_decision(&on_screen_bounds(), &inside_bounds(), &screen(), false),
        None
    );
}

#[test]
fn zero_area_geometry_trips_the_zero_area_guard() {
    let bounds = Rect {
        x: 100.0,
        y: 100.0,
        width: 0.0,
        height: 20.0,
    };
    assert_eq!(
        pre_probe_decision(&bounds, &Point { x: 100.0, y: 105.0 }, &screen(), false),
        Some(PreProbeGuard::ZeroArea)
    );
}

/// The minimized shape is checked on geometry the other guards accept, so
/// deleting the `IsIconic` arm alone is what this test fails on. The live
/// minimized fixture cannot isolate it: minimized descendants keep real
/// extents anchored at −32000 (A5-3, A14-8), which the virtual-screen guard
/// answers first.
#[test]
fn a_minimized_root_trips_the_iconic_guard_on_probeable_geometry() {
    assert_eq!(
        pre_probe_decision(&on_screen_bounds(), &inside_bounds(), &screen(), true),
        Some(PreProbeGuard::IconicRoot)
    );
    assert_eq!(
        pre_probe_decision(&on_screen_bounds(), &inside_bounds(), &screen(), false),
        None,
        "the same geometry with a restored root must reach the probe"
    );
}

#[test]
fn freed_coordinates_trip_the_virtual_screen_guard() {
    let bounds = Rect {
        x: -32_000.0,
        y: -32_000.0,
        width: 100.0,
        height: 100.0,
    };
    let point = Point {
        x: -32_000.0,
        y: -32_000.0,
    };
    assert_eq!(
        pre_probe_decision(&bounds, &point, &screen(), false),
        Some(PreProbeGuard::OutsideVirtualScreen)
    );
}

/// A18-6 measured `ElementFromPoint` answering with the desktop at
/// coordinates outside the virtual screen, and the pixel at the far edge is
/// the first one outside it — Win32 rectangles are half-open there.
#[test]
fn a_point_on_the_screens_far_edge_is_outside_it() {
    let far_edge = Point {
        x: screen().x + screen().width,
        y: screen().y + screen().height / 2.0,
    };
    let bounds = Rect {
        x: far_edge.x - 20.0,
        y: far_edge.y - 20.0,
        width: 40.0,
        height: 40.0,
    };
    assert_eq!(
        pre_probe_decision(&bounds, &far_edge, &screen(), false),
        Some(PreProbeGuard::OutsideVirtualScreen)
    );
}

#[test]
fn a_point_outside_the_target_bounds_trips_its_own_guard() {
    assert_eq!(
        pre_probe_decision(
            &on_screen_bounds(),
            &Point { x: 10.0, y: 10.0 },
            &screen(),
            false
        ),
        Some(PreProbeGuard::OutsideTargetBounds)
    );
}

#[test]
fn every_guard_trip_is_unknown_never_intercepted() {
    for guard in PreProbeGuard::ALL {
        let result = result_for_guard(guard);
        assert_eq!(result, HitTestResult::Unknown, "{guard:?} must be Unknown");
        assert!(
            !matches!(result, HitTestResult::InterceptedBy { .. }),
            "{guard:?} must never invent InterceptedBy"
        );
    }
}

#[test]
fn rectangle_membership_is_half_open_on_the_far_edges() {
    let bounds = on_screen_bounds();
    let near_corner = Point {
        x: bounds.x,
        y: bounds.y,
    };
    let far_corner = Point {
        x: bounds.x + bounds.width,
        y: bounds.y + bounds.height,
    };
    let last_inside = Point {
        x: far_corner.x - 1.0,
        y: far_corner.y - 1.0,
    };
    assert!(
        point_in_rect(&near_corner, &bounds),
        "left/top are inclusive"
    );
    assert!(point_in_rect(&last_inside, &bounds));
    assert!(
        !point_in_rect(&far_corner, &bounds),
        "right/bottom edges address the first pixel outside the rectangle"
    );
    assert!(!point_in_rect(
        &Point {
            x: far_corner.x,
            y: last_inside.y
        },
        &bounds
    ));
    assert!(!point_in_rect(
        &Point {
            x: last_inside.x,
            y: far_corner.y
        },
        &bounds
    ));
}

#[test]
fn area_requires_positive_and_finite_extents() {
    assert!(rect_has_area(&on_screen_bounds()));
    assert!(!rect_has_area(&Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 10.0
    }));
    assert!(!rect_has_area(&Rect {
        x: 0.0,
        y: 0.0,
        width: -1.0,
        height: 10.0
    }));
    assert!(!rect_has_area(&Rect {
        x: f64::NAN,
        y: 0.0,
        width: 10.0,
        height: 10.0
    }));
    assert!(!rect_has_area(&Rect {
        x: 0.0,
        y: 0.0,
        width: f64::INFINITY,
        height: 10.0
    }));
}
