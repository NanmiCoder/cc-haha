use super::{
    EnumerationOutcome, capture_selection, capture_selection_in, classify_enumeration, display_at,
    display_identity_matches, intersection_area, list_displays_live, primaries_first,
    scale_for_bounds, scale_for_bounds_in, verify_display_identity,
};
use agent_desktop_core::{DisplayInfo, ErrorCode, Rect};

#[test]
fn primary_display_orders_first() {
    let mut displays = vec![
        display("monitor-2", false, 1.0, rect(0.0, 0.0, 100.0, 100.0)),
        display("monitor-1", true, 1.0, rect(0.0, 0.0, 100.0, 100.0)),
    ];
    primaries_first(&mut displays);

    assert!(displays[0].is_primary);
    assert_eq!(displays[0].id, "monitor-1");
}

#[cfg(target_os = "windows")]
#[test]
fn a_successful_read_with_a_positive_dpi_yields_a_scale() {
    assert_eq!(super::effective_dpi_scale(0, 144), Some(1.5));
}

#[cfg(target_os = "windows")]
#[test]
fn a_failed_read_is_none_even_with_a_positive_leftover_dpi() {
    assert_eq!(
        super::effective_dpi_scale(0x8007_0057_u32 as i32, 96),
        None,
        "a failed call's dpi output is leftover data, not evidence of scale 1.0"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn a_successful_read_with_a_zero_dpi_is_none() {
    assert_eq!(super::effective_dpi_scale(0, 0), None);
}

#[cfg(target_os = "windows")]
#[test]
fn live_listing_returns_exactly_one_primary_display() {
    crate::tree::fixture::ensure_test_apartment();
    let displays = list_displays_live(deadline(5_000)).expect("live display enumeration succeeds");

    assert_eq!(
        displays.iter().filter(|display| display.is_primary).count(),
        1,
        "Windows has one primary display; a listing that marks several has lost the flag"
    );
    assert!(
        displays
            .iter()
            .all(|display| display.scale >= 1.0 && display.scale.is_finite()),
        "scale is rule-shaped: finite and at least 1.0"
    );
    assert!(
        displays
            .iter()
            .all(|display| display.bounds.width > 0.0 && display.bounds.height > 0.0),
        "bounds are non-degenerate"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn display_at_zero_matches_list_displays_primary() {
    crate::tree::fixture::ensure_test_apartment();
    let listed = list_displays_live(deadline(5_000)).expect("list displays");
    let at_zero = display_at(0, deadline(5_000)).expect("display at 0");

    assert_eq!(at_zero, listed[0]);
    assert!(at_zero.is_primary);
}

#[cfg(target_os = "windows")]
#[test]
fn display_at_out_of_range_is_invalid_args() {
    crate::tree::fixture::ensure_test_apartment();
    let listed = list_displays_live(deadline(5_000)).expect("list displays");
    let error = display_at(listed.len(), deadline(5_000)).expect_err("out of range");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[cfg(target_os = "windows")]
#[test]
fn capture_selection_round_trips_live_display() {
    crate::tree::fixture::ensure_test_apartment();
    let listed = list_displays_live(deadline(5_000)).expect("list displays");
    let expected = listed[0].clone();
    let (index, selected) = capture_selection(&expected, deadline(5_000)).expect("selection");

    assert_eq!(index, 0);
    assert_eq!(selected, expected);
}

#[cfg(target_os = "windows")]
#[test]
fn scale_for_bounds_uses_owning_display_scale() {
    crate::tree::fixture::ensure_test_apartment();
    let listed = list_displays_live(deadline(5_000)).expect("list displays");
    let primary = &listed[0];
    let inset = Rect {
        x: primary.bounds.x + primary.bounds.width * 0.25,
        y: primary.bounds.y + primary.bounds.height * 0.25,
        width: primary.bounds.width * 0.5,
        height: primary.bounds.height * 0.5,
    };
    let scale = scale_for_bounds(Some(inset), deadline(5_000)).expect("scale");

    assert_eq!(scale, primary.scale);
}

#[test]
fn intersection_area_selects_the_display_containing_most_of_a_window() {
    let window = rect(90.0, 0.0, 40.0, 50.0);
    let left = rect(0.0, 0.0, 100.0, 100.0);
    let right = rect(100.0, 0.0, 100.0, 100.0);

    assert_eq!(intersection_area(window, left), 500.0);
    assert_eq!(intersection_area(window, right), 1_500.0);
}

#[test]
fn scale_for_bounds_picks_largest_overlap_not_top_left() {
    let displays = vec![
        display("primary", true, 2.0, rect(0.0, 0.0, 100.0, 100.0)),
        display("external", false, 1.25, rect(100.0, 0.0, 100.0, 100.0)),
    ];
    let straddling = rect(90.0, 0.0, 40.0, 50.0);

    assert_eq!(
        scale_for_bounds_in(&displays, Some(straddling)).expect("straddle"),
        1.25
    );
}

#[test]
fn scale_for_bounds_falls_back_to_primary_when_outside_every_display() {
    let displays = vec![
        display("primary", true, 1.5, rect(0.0, 0.0, 100.0, 100.0)),
        display("external", false, 2.0, rect(200.0, 0.0, 100.0, 100.0)),
    ];
    let outside = rect(-500.0, -500.0, 10.0, 10.0);

    assert_eq!(
        scale_for_bounds_in(&displays, Some(outside)).expect("primary fallback"),
        1.5
    );
    assert_eq!(
        scale_for_bounds_in(&displays, None).expect("none uses primary"),
        1.5
    );
}

#[test]
fn scale_for_bounds_falls_back_to_first_when_no_primary_flag() {
    let displays = vec![
        display("a", false, 1.25, rect(0.0, 0.0, 100.0, 100.0)),
        display("b", false, 2.0, rect(100.0, 0.0, 100.0, 100.0)),
    ];
    let outside = rect(-50.0, -50.0, 10.0, 10.0);

    assert_eq!(
        scale_for_bounds_in(&displays, Some(outside)).expect("first fallback"),
        1.25
    );
}

#[test]
fn empty_display_inventory_is_invalid_args() {
    let error = scale_for_bounds_in(&[], None).expect_err("missing displays");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn capture_selection_fails_when_expected_bounds_mutate() {
    let live = display("monitor-1", true, 1.0, rect(0.0, 0.0, 1920.0, 1080.0));
    let mut expected = live.clone();
    expected.bounds.width += 1.0;

    let error = capture_selection_in(&[live], &expected).expect_err("bounds mismatch");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn capture_selection_fails_when_expected_scale_mutates() {
    let live = display("monitor-1", true, 1.0, rect(0.0, 0.0, 1920.0, 1080.0));
    let mut expected = live.clone();
    expected.scale = 1.25;

    let error = capture_selection_in(&[live], &expected).expect_err("scale mismatch");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn capture_selection_fails_when_expected_primary_mutates() {
    let live = display("monitor-1", true, 1.0, rect(0.0, 0.0, 1920.0, 1080.0));
    let mut expected = live.clone();
    expected.is_primary = false;

    let error = capture_selection_in(&[live], &expected).expect_err("primary mismatch");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn capture_selection_fails_when_id_is_absent() {
    let live = display("monitor-1", true, 1.0, rect(0.0, 0.0, 1920.0, 1080.0));
    let expected = display("monitor-404", true, 1.0, rect(0.0, 0.0, 1920.0, 1080.0));

    let error = capture_selection_in(&[live], &expected).expect_err("missing id");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(error.message.contains("monitor-404"));
}

#[test]
fn verify_display_identity_requires_id_with_geometry() {
    let expected = display("monitor-1", true, 1.0, rect(0.0, 0.0, 100.0, 100.0));
    let same_id_different_bounds = display("monitor-1", true, 1.0, rect(0.0, 0.0, 200.0, 200.0));

    assert!(display_identity_matches(&expected, &expected));
    assert!(!display_identity_matches(
        &expected,
        &same_id_different_bounds
    ));

    let error = verify_display_identity(0, &expected, &same_id_different_bounds)
        .expect_err("recycled handle with different geometry");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

use crate::system::fixture::test_time::deadline;

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

/// The three outcomes an enumeration pass can reach, told apart on any host.
/// Before this split a failed enumeration and a genuinely display-less machine
/// were the same empty success, and only the second of those is a fact a
/// caller can act on.
#[test]
fn a_completed_enumeration_is_not_confused_with_a_failed_one() {
    assert_eq!(
        classify_enumeration(true, false, false),
        EnumerationOutcome::Completed
    );
    assert_eq!(
        classify_enumeration(false, false, false),
        EnumerationOutcome::EnumerationFailed
    );
}

/// A monitor whose `GetMonitorInfoW` fails used to be skipped, so it vanished
/// from the list and a desktop whose every monitor failed was indistinguishable
/// from a machine with no displays. It stops the pass and is reported as
/// itself, exactly as an unreadable DPI already was.
#[test]
fn an_unreadable_monitor_info_is_reported_as_itself_rather_than_a_shorter_list() {
    assert_eq!(
        classify_enumeration(false, true, false),
        EnumerationOutcome::MonitorInfoUnreadable
    );
    assert_eq!(
        classify_enumeration(true, true, false),
        EnumerationOutcome::MonitorInfoUnreadable
    );
}

/// An unreadable DPI outranks the enumeration's own return, because the pass
/// stopped early and its zero says nothing about the monitors themselves.
#[test]
fn an_unreadable_dpi_is_reported_as_itself_rather_than_as_an_enumeration_failure() {
    assert_eq!(
        classify_enumeration(false, false, true),
        EnumerationOutcome::DpiUnreadable
    );
    assert_eq!(
        classify_enumeration(true, false, true),
        EnumerationOutcome::DpiUnreadable
    );
}
