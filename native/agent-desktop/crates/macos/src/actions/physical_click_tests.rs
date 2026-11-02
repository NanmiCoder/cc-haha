use super::delivery_point;
use agent_desktop_core::{Point, Rect};

fn bounds() -> Rect {
    Rect {
        x: 10.0,
        y: 20.0,
        width: 100.0,
        height: 40.0,
    }
}

#[test]
fn physical_delivery_uses_the_point_proven_by_preflight() {
    let verified = Point { x: 35.0, y: 30.0 };

    assert_eq!(delivery_point(bounds(), Some(&verified)).unwrap(), verified);
}

#[test]
fn physical_delivery_centers_only_without_a_verified_point() {
    assert_eq!(
        delivery_point(bounds(), None).unwrap(),
        Point { x: 60.0, y: 40.0 }
    );
}

#[test]
fn physical_delivery_rejects_a_verified_point_outside_live_bounds() {
    let stale = Point { x: 9.0, y: 30.0 };

    let error = delivery_point(bounds(), Some(&stale)).unwrap_err();

    assert_eq!(error.code, agent_desktop_core::ErrorCode::StaleRef);
}
