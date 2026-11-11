use super::imp::{
    capture_selection_in, display_at_capture_index_in, intersection_area, order_public_displays,
    scale_for_bounds_in, scale_from_mode,
};
use agent_desktop_core::{DisplayInfo, ErrorCode, Rect};

#[test]
fn intersection_area_selects_the_display_containing_most_of_a_window() {
    let window = rect(90.0, 0.0, 40.0, 50.0);
    let left = rect(0.0, 0.0, 100.0, 100.0);
    let right = rect(100.0, 0.0, 100.0, 100.0);

    assert_eq!(intersection_area(window, left), 500.0);
    assert_eq!(intersection_area(window, right), 1_500.0);
}

#[test]
fn window_capture_scale_comes_from_the_display_with_largest_overlap() {
    let displays = vec![
        display("main", true, 2.0, rect(0.0, 0.0, 100.0, 100.0)),
        display("external", false, 1.0, rect(100.0, 0.0, 100.0, 100.0)),
    ];
    let window = rect(90.0, 0.0, 40.0, 50.0);

    assert_eq!(
        scale_for_bounds_in(&displays, Some(window)).expect("window display"),
        1.0
    );
    assert_eq!(
        scale_for_bounds_in(&displays, None).expect("primary display"),
        2.0
    );
}

#[test]
fn missing_display_inventory_is_not_silently_scaled() {
    let error = scale_for_bounds_in(&[], None).expect_err("missing displays");

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}

#[test]
fn mode_scale_is_orientation_independent() {
    assert_eq!(scale_from_mode(1440.0, 2880.0).unwrap(), 2.0);
    assert_eq!(scale_from_mode(900.0, 1800.0).unwrap(), 2.0);
}

#[test]
fn public_order_is_primary_then_numeric_display_id() {
    let mut displays = inventory();

    order_public_displays(&mut displays);

    let ordered = displays
        .into_iter()
        .map(|(id, raw_index, _)| (id, raw_index))
        .collect::<Vec<_>>();
    assert_eq!(ordered, vec![(100, 0), (20, 2), (300, 1)]);
}

#[test]
fn stable_display_id_maps_to_its_raw_capture_index() {
    let (raw_index, selected) = capture_selection_in(inventory(), "20").expect("display selection");

    assert_eq!(raw_index, 2);
    assert_eq!(selected.id, "20");
}

#[test]
fn missing_stable_display_id_has_no_capture_selection() {
    assert!(capture_selection_in(inventory(), "404").is_none());
}

#[test]
fn raw_slot_reorder_exposes_identity_change() {
    let reordered = vec![
        inventory_display(100, 0, true),
        inventory_display(20, 1, false),
        inventory_display(300, 2, false),
    ];

    let after = display_at_capture_index_in(reordered, 2).expect("raw slot");

    assert_eq!(after.id, "300");
    assert_ne!(after.id, "20");
}

fn inventory() -> Vec<(u32, usize, DisplayInfo)> {
    vec![
        inventory_display(100, 0, true),
        inventory_display(300, 1, false),
        inventory_display(20, 2, false),
    ]
}

fn inventory_display(id: u32, raw_index: usize, is_primary: bool) -> (u32, usize, DisplayInfo) {
    (
        id,
        raw_index,
        display(
            &id.to_string(),
            is_primary,
            1.0,
            rect(0.0, 0.0, 100.0, 100.0),
        ),
    )
}

fn display(id: &str, is_primary: bool, scale: f64, bounds: Rect) -> DisplayInfo {
    DisplayInfo {
        id: id.into(),
        bounds,
        is_primary,
        scale,
    }
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}
