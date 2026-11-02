use agent_desktop_core::ErrorCode;

use super::*;
use crate::system::capture::fullscreen_route::ROOT_DRAWABLE;
use crate::system::capture::window::fakes::*;

fn two() -> Vec<DisplayInfo> {
    vec![
        display_at("left", 0.0, 1920.0, 1.0, false),
        display_at("right", 1920.0, 2560.0, 2.0, true),
    ]
}

#[test]
fn full_screen_picks_the_primary_when_it_is_not_first() {
    let (index, display) = select(&two(), &ScreenshotTarget::FullScreen).expect("a display");
    assert_eq!((index, display.id.as_str()), (1, "right"));
}

#[test]
fn full_screen_with_no_primary_picks_the_first() {
    let mut displays = two();
    displays[1].is_primary = false;
    let (index, _) = select(&displays, &ScreenshotTarget::FullScreen).expect("a display");
    assert_eq!(index, 0);
}

#[test]
fn a_screen_out_of_range_is_invalid_with_the_display_count() {
    let error = select(&two(), &ScreenshotTarget::Screen(5)).expect_err("out of range");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|d| d["display_count"].as_u64()),
        Some(2)
    );
}

#[test]
fn a_display_that_differs_from_what_the_caller_saw_is_invalid() {
    let mut expected = two()[1].clone();
    expected.bounds.width = 1280.0;
    let target = ScreenshotTarget::Display { index: 1, expected };
    let error = select(&two(), &target).expect_err("changed");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    let same = ScreenshotTarget::Display {
        index: 1,
        expected: two()[1].clone(),
    };
    assert!(select(&two(), &same).is_ok());
}

#[test]
fn the_scale_of_the_display_with_the_largest_overlap_wins() {
    let rect = Rect {
        x: 1800.0,
        y: 0.0,
        width: 400.0,
        height: 100.0,
    };
    assert!((scale_for(&two(), rect) - 2.0).abs() < f64::EPSILON);
    let leftmost = Rect { x: 1000.0, ..rect };
    assert!((scale_for(&two(), leftmost) - 1.0).abs() < f64::EPSILON);
}

#[test]
fn a_rectangle_on_no_display_has_scale_one() {
    let rect = Rect {
        x: 9000.0,
        y: 9000.0,
        width: 10.0,
        height: 10.0,
    };
    assert!((scale_for(&two(), rect) - 1.0).abs() < f64::EPSILON);
}

fn rig_with(displays: Vec<Option<Vec<DisplayInfo>>>) -> Rig {
    let rig = Rig::standard();
    rig.lookup.displays.set(displays);
    rig
}

#[test]
fn a_display_capture_grabs_exactly_the_display_rectangle_from_the_root() {
    let rig = rig_with(vec![Some(two())]);
    let image = capture(&rig.env(), &ScreenshotTarget::Screen(1), deadline()).expect("captured");
    let (drawable, rect) = rig.grabber.last_grab();
    assert_eq!(drawable, ROOT_DRAWABLE);
    assert_eq!(rect, (1920, 0, 2560, 1080));
    assert_eq!((image.width, image.height), (2560, 1080));
    assert!((image.scale_factor - 2.0).abs() < f64::EPSILON);
}

#[test]
fn an_expected_display_that_differs_before_the_grab_issues_no_grab() {
    let rig = rig_with(vec![Some(two())]);
    let mut expected = two()[0].clone();
    expected.id = "gone".to_owned();
    let target = ScreenshotTarget::Display { index: 0, expected };
    let error = capture(&rig.env(), &target, deadline()).expect_err("changed");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(rig.grabber.grab_count(), 0);
}

#[test]
fn a_display_that_changes_during_the_grab_discards_the_bytes() {
    let mut moved = two();
    moved[0].bounds.width = 1280.0;
    let rig = rig_with(vec![Some(two()), Some(moved)]);
    let error = capture(&rig.env(), &ScreenshotTarget::Screen(0), deadline()).expect_err("changed");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(rig.grabber.grab_count(), 1);
}

#[test]
fn an_unlistable_display_set_is_the_listers_error() {
    let rig = rig_with(vec![None]);
    let error = capture(&rig.env(), &ScreenshotTarget::FullScreen, deadline()).expect_err("none");
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(rig.grabber.grab_count(), 0);
}
