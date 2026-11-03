use agent_desktop_core::{Direction, Rect};

use super::{direction_for_visibility, rect_has_area, scroll_effect_observed};

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn area_requires_finite_positive_dimensions_and_coordinates() {
    assert!(rect_has_area(rect(0.0, 0.0, 10.0, 10.0)));
    assert!(!rect_has_area(rect(0.0, 0.0, 0.0, 10.0)));
    assert!(!rect_has_area(rect(0.0, 0.0, -1.0, 10.0)));
    assert!(!rect_has_area(rect(f64::NAN, 0.0, 10.0, 10.0)));
    assert!(!rect_has_area(rect(0.0, 0.0, f64::INFINITY, 10.0)));
}

#[test]
fn offscreen_direction_uses_global_viewport_edges() {
    let viewport = rect(1496.0, 87.0, 1496.0, 937.0);

    assert!(matches!(
        direction_for_visibility(rect(2030.0, 1026.0, 73.0, 24.0), viewport),
        Some(Direction::Down)
    ));
    assert!(matches!(
        direction_for_visibility(rect(2030.0, 80.0, 73.0, 24.0), viewport),
        Some(Direction::Up)
    ));
    assert!(direction_for_visibility(rect(1500.0, 100.0, 73.0, 24.0), viewport).is_none());
}

#[test]
fn nested_viewport_requires_scrolling_even_inside_window() {
    let target = rect(370.0, 466.0, 202.0, 32.0);
    let window = rect(300.0, 135.0, 500.0, 632.0);
    let viewport = rect(350.0, 617.0, 300.0, 100.0);

    assert!(direction_for_visibility(target, window).is_none());
    assert!(matches!(
        direction_for_visibility(target, viewport),
        Some(Direction::Up)
    ));
}

#[test]
fn scroll_area_target_seeds_viewport_search_at_parent() {
    assert!(matches!(
        super::imp::viewport_seed(true),
        super::imp::ViewportSeed::Parent
    ));
    assert!(matches!(
        super::imp::viewport_seed(false),
        super::imp::ViewportSeed::Target
    ));

    let target_bounds = rect(360.0, 700.0, 200.0, 150.0);
    let enclosing_bounds = rect(350.0, 100.0, 500.0, 620.0);
    assert!(direction_for_visibility(target_bounds, target_bounds).is_none());
    assert!(matches!(
        direction_for_visibility(target_bounds, enclosing_bounds),
        Some(Direction::Down)
    ));
}

#[test]
fn final_scroll_read_timeout_does_not_claim_safe_non_delivery() {
    let error = agent_desktop_core::AdapterError::timeout("final bounds read")
        .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered());
    let error = super::imp::settled_scroll_outcome(None, Err(error)).unwrap_err();
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn acknowledged_scroll_without_geometry_change_is_not_delivery() {
    let before = rect(2622.0, 1063.0, 177.0, 24.0);

    assert!(!scroll_effect_observed(Some(before), Some(before)));
    assert!(scroll_effect_observed(
        Some(before),
        Some(rect(2622.0, 900.0, 177.0, 24.0))
    ));
}
