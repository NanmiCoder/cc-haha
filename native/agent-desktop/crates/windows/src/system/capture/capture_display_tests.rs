use super::{
    capture_display_at, capture_display_bounds, display_capture_geometry, fail_after_alloc,
    gdi_balance,
};
use crate::system::display::{display_at, list_displays_live};
use crate::tree::fixture::bootstrap;
use agent_desktop_core::{Deadline, ErrorCode, Rect};
use std::time::Duration;

use crate::system::fixture::test_time::deadline;

#[test]
fn index_zero_matches_primary_enumeration_dimensions() {
    bootstrap();
    let displays = list_displays_live(deadline(10_000)).expect("enumerate displays");
    let primary = displays
        .iter()
        .find(|display| display.is_primary)
        .expect("at least one primary display");
    let expected_w = primary.bounds.width as u32;
    let expected_h = primary.bounds.height as u32;

    let indexed = capture_display_at(0, deadline(10_000)).expect("index 0 is the primary");
    assert_eq!((indexed.width, indexed.height), (expected_w, expected_h));

    let at = display_at(0, deadline(10_000)).expect("display_at(0)");
    assert_eq!(at.id, primary.id);
    assert_eq!(
        (at.bounds.width as u32, at.bounds.height as u32),
        (expected_w, expected_h)
    );
}

#[test]
fn per_monitor_capture_uses_enumerated_dimensions_not_literals() {
    bootstrap();
    let displays = list_displays_live(deadline(10_000)).expect("enumerate displays");
    for (index, display) in displays.iter().enumerate() {
        let image = capture_display_at(index, deadline(10_000))
            .unwrap_or_else(|error| panic!("capture display {index}: {error:?}"));
        assert_eq!(
            (image.width, image.height),
            (display.bounds.width as u32, display.bounds.height as u32),
            "capture dimensions must come from enumeration entry {index}"
        );
        assert_eq!(image.scale_factor, display.scale);
    }
}

#[test]
fn zero_area_display_bounds_are_rejected_before_bitmap_alloc() {
    bootstrap();
    gdi_balance::reset();
    let before = gdi_balance::live();
    let error = display_capture_geometry(Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 100.0,
    })
    .expect_err("zero width is rejected");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(gdi_balance::live(), before);

    let error = capture_display_bounds(
        Rect {
            x: -100.0,
            y: -50.0,
            width: 0.0,
            height: 0.0,
        },
        1.0,
        deadline(10_000),
    )
    .expect_err("zero-area bounds never allocate");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(gdi_balance::live(), before);
}

#[test]
fn oversized_bounds_are_rejected_while_ordinary_bounds_are_accepted() {
    let oversized = display_capture_geometry(Rect {
        x: 0.0,
        y: 0.0,
        width: 23171.0,
        height: 23171.0,
    })
    .expect_err("a region whose byte count overflows i32 must be refused");
    assert_eq!(oversized.code, ErrorCode::InvalidArgs);

    let (width, height, _, _) = display_capture_geometry(Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    })
    .expect("an ordinary display size must still be accepted");
    assert_eq!((width, height), (1920, 1080));
}

#[test]
fn negative_origin_geometry_is_preserved_for_multi_monitor_arithmetic() {
    let (width, height, origin_x, origin_y) = display_capture_geometry(Rect {
        x: -1920.0,
        y: -100.0,
        width: 1920.0,
        height: 1080.0,
    })
    .expect("negative origins are valid");
    assert_eq!((width, height), (1920, 1080));
    assert_eq!((origin_x, origin_y), (-1920, -100));
}

#[test]
fn gdi_objects_balance_across_success_deadline_and_forced_failure() {
    bootstrap();
    gdi_balance::reset();

    let _ = capture_display_at(0, deadline(10_000)).expect("success path");
    assert_eq!(
        gdi_balance::live(),
        0,
        "success path must release every GDI object"
    );

    let expired = Deadline::after(1).expect("tiny deadline");
    std::thread::sleep(Duration::from_millis(5));
    let timeout = capture_display_at(0, expired).expect_err("expired deadline");
    assert_eq!(timeout.code, ErrorCode::Timeout);
    assert_eq!(
        gdi_balance::live(),
        0,
        "early deadline abort allocates nothing"
    );

    let forced = fail_after_alloc::with(|| capture_display_at(0, deadline(10_000)))
        .expect_err("forced failure after allocation");
    assert_eq!(forced.code, ErrorCode::ActionFailed);
    assert_eq!(
        gdi_balance::live(),
        0,
        "forced failure must still Drop every GDI object"
    );
}
