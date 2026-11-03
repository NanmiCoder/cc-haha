use super::{normalize_axis, normalize_point, primary_screen_metrics};
use crate::tree::hit_test::virtual_screen_metrics;
use agent_desktop_core::Point;

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

#[test]
fn a_point_inside_the_primary_rect_normalizes_against_the_primary_monitor() {
    let (width, height) = primary_screen_metrics();
    assert!(
        width > 0 && height > 0,
        "primary monitor metrics must be positive on any interactive host"
    );
    let target = point(f64::from(width) / 2.0, f64::from(height) / 2.0);
    let normalized = normalize_point(&target);

    assert!(!normalized.virtual_desktop);
    assert_eq!(normalized.x, normalize_axis(target.x, 0, width));
    assert_eq!(normalized.y, normalize_axis(target.y, 0, height));
}

#[test]
fn the_primary_origin_normalizes_to_the_lowest_absolute_coordinate() {
    let normalized = normalize_point(&point(0.0, 0.0));

    assert!(!normalized.virtual_desktop);
    assert_eq!(normalized.x, 0);
    assert_eq!(normalized.y, 0);
}

#[test]
fn a_point_at_or_beyond_the_primary_extent_takes_the_virtual_desktop_branch() {
    let (width, height) = primary_screen_metrics();
    let target = point(f64::from(width), f64::from(height));
    let normalized = normalize_point(&target);

    assert!(normalized.virtual_desktop);
    let (left, top, vwidth, vheight) = virtual_screen_metrics();
    assert_eq!(normalized.x, normalize_axis(target.x, left, vwidth));
    assert_eq!(normalized.y, normalize_axis(target.y, top, vheight));
}

#[test]
fn a_negative_point_is_off_primary_and_normalizes_against_the_virtual_screen() {
    let target = point(-1.0, -1.0);
    let normalized = normalize_point(&target);

    assert!(normalized.virtual_desktop);
    let (left, top, vwidth, vheight) = virtual_screen_metrics();
    assert_eq!(normalized.x, normalize_axis(target.x, left, vwidth));
    assert_eq!(normalized.y, normalize_axis(target.y, top, vheight));
}

#[test]
fn normalize_axis_maps_the_origin_to_zero_and_clamps_beyond_the_extent() {
    assert_eq!(normalize_axis(0.0, 0, 1_000), 0);
    assert_eq!(normalize_axis(2_000.0, 0, 1_000), 65_535);
}

#[test]
fn normalize_axis_treats_a_non_positive_extent_as_the_origin() {
    assert_eq!(normalize_axis(500.0, 0, 0), 0);
    assert_eq!(normalize_axis(500.0, 0, -10), 0);
}
