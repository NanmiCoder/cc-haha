use super::*;
use crate::tree::hit_test::tests::rect;

#[test]
fn rectangle_boundaries_use_widened_half_open_coordinates() {
    let button = rect(100, 100, 80, 24);
    for point in [(100, 100), (140, 112), (179, 123)] {
        assert!(admits(button, point), "{point:?} lies inside");
    }
    for point in [(220, 110), (180, 110), (99, 110), (110, 124)] {
        assert!(!admits(button, point), "{point:?} lies outside");
    }

    assert!(admits(rect(i32::MAX - 3, 0, 10, 1), (i32::MAX, 0)));
    assert!(!admits(rect(i32::MAX - 3, 0, 10, 1), (i32::MIN, 0)));
}

#[test]
fn pixels_floor_and_reject_non_finite_values() {
    assert_eq!(pixel(310.9, 154.0), Some((310, 154)));
    assert_eq!(pixel(-0.5, 2.0), Some((-1, 2)));
    assert_eq!(pixel(f64::NAN, 1.0), None);
    assert_eq!(pixel(1.0, f64::INFINITY), None);
    assert_eq!(pixel(1e12, 1.0), None);
}
