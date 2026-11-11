use super::fakes::*;
use super::*;
use crate::system::x11::stacking::stacking_read::StackingRead;

fn covering() -> StackingRead {
    snapshot(
        vec![
            stacked(CLIENT, extents(101, 138, 1000, 700)),
            stacked(11, extents(500, 400, 100, 100)),
        ],
        Vec::new(),
    )
}

fn reason_of(error: &AdapterError) -> Option<&str> {
    error
        .details
        .as_ref()
        .and_then(|details| details["reason"].as_str())
}

#[test]
fn an_unproven_redirect_refuses_and_issues_no_plain_grab() {
    let rig = Rig::standard();
    *rig.grabber.redirect_with.lock().expect("redirect lock") =
        Box::new(|_, _| Err(GrabError::UnprovenPaint));
    rig.stacking.reads.set(vec![covering()]);
    let error = capture(&rig.env(), &target(), false, deadline()).expect_err("covered");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(reason_of(&error), Some("covered"));
    assert_eq!(rig.grabber.grab_count(), 0);
    assert_eq!(rig.grabber.redirect_count(), 1);
}

#[test]
fn a_cover_is_read_through_the_redirect_and_never_by_a_plain_grab() {
    let rig = Rig::standard();
    rig.grabber.redirect_works();
    rig.stacking.reads.set(vec![covering()]);
    let image = capture(&rig.env(), &target(), false, deadline()).expect("captured");
    assert_eq!(rig.grabber.grab_count(), 0);
    assert_eq!(rig.grabber.redirect_count(), 1);
    assert_eq!(image.width, 1002);
}

#[test]
fn a_clear_window_is_a_plain_grab_and_never_a_redirect() {
    let rig = Rig::standard();
    rig.grabber.redirect_works();
    capture(&rig.env(), &target(), false, deadline()).expect("captured");
    assert_eq!(rig.grabber.grab_count(), 1);
    assert_eq!(rig.grabber.redirect_count(), 0);
}

#[test]
fn redirect_failures_preserve_the_cause_without_false_focus_advice() {
    use crate::system::x11::capture::grab_error::GrabError;
    for (failure, code, reason) in [
        (GrabError::Timeout, ErrorCode::Timeout, None),
        (GrabError::Resource, ErrorCode::ActionFailed, None),
        (GrabError::Unviewable, ErrorCode::ActionFailed, None),
        (
            GrabError::OffScreen,
            ErrorCode::ActionFailed,
            Some("off_screen"),
        ),
        (
            GrabError::Fault(crate::system::x11::MonitorFault::Unreadable),
            ErrorCode::ActionFailed,
            None,
        ),
        (
            GrabError::Fault(crate::system::x11::MonitorFault::Unreachable(
                ":missing".to_owned(),
            )),
            ErrorCode::PlatformNotSupported,
            None,
        ),
        (
            GrabError::UnprovenPaint,
            ErrorCode::ActionFailed,
            Some("covered"),
        ),
    ] {
        let rig = Rig::standard();
        rig.stacking.reads.set(vec![covering()]);
        *rig.grabber.redirect_with.lock().expect("redirect lock") =
            Box::new(move |_, _| Err(failure.clone()));
        let error = capture(&rig.env(), &target(), false, deadline()).expect_err("no image");
        assert_eq!(error.code, code);
        assert_eq!(reason_of(&error), reason);
        assert_eq!(
            error
                .suggestion
                .as_deref()
                .unwrap_or_default()
                .contains("focus-window"),
            reason == Some("covered")
        );
    }
}

#[test]
fn the_same_cover_on_a_compositing_session_still_grabs() {
    let rig = Rig::standard();
    rig.compose_on();
    rig.stacking.reads.set(vec![covering()]);
    capture(&rig.env(), &target(), false, deadline()).expect("captured");
    assert_eq!(rig.grabber.grab_count(), 1);
    assert_eq!(rig.grabber.redirect_count(), 0);
}

#[test]
fn a_cover_that_appears_after_the_grab_discards_the_bytes() {
    let rig = Rig::standard();
    rig.stacking.reads.set(vec![clear_read(), covering()]);
    let error = capture(&rig.env(), &target(), false, deadline()).expect_err("covered");
    assert_eq!(reason_of(&error), Some("covered"));
    assert_eq!(rig.grabber.grab_count(), 1);
}

#[test]
fn unknown_stacking_takes_the_redirect_route_and_refuses_without_one() {
    let rig = Rig::standard();
    rig.stacking.reads.set(vec![StackingRead::Unavailable]);
    let error = capture(&rig.env(), &target(), false, deadline()).expect_err("unknown");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(rig.grabber.grab_count(), 0);
    let working = Rig::standard();
    working.grabber.redirect_works();
    working.stacking.reads.set(vec![StackingRead::Unavailable]);
    capture(&working.env(), &target(), false, deadline()).expect("captured");
    assert_eq!(working.grabber.redirect_count(), 1);
}

fn unproven_bounds() -> Option<Rect> {
    Some(Rect {
        x: 100.0,
        y: 100.0,
        width: 1000.0,
        height: 900.0,
    })
}

#[test]
fn bounds_no_drawable_matches_still_return_the_frame_from_screenshot() {
    let rig = Rig::standard();
    rig.lookup
        .resolved
        .set(vec![Some(window_info(unproven_bounds()))]);
    capture(&rig.env(), &target(), false, deadline()).expect("captured");
    assert_eq!(rig.grabber.last_grab().0, FRAME);
}

#[test]
fn bounds_no_drawable_matches_refuse_the_debug_frame_without_a_grab() {
    let rig = Rig::standard();
    rig.lookup
        .resolved
        .set(vec![Some(window_info(unproven_bounds()))]);
    let error = capture(&rig.env(), &target(), true, deadline()).expect_err("unproven");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.message,
        "No drawable of the window matches the bounds the window reports"
    );
    assert_eq!(
        error.suggestion.as_deref(),
        Some("Capture the window with 'screenshot --window-id' instead")
    );
    assert_eq!(reason_of(&error), None);
    assert_eq!(rig.grabber.grab_count(), 0);
}

#[test]
fn missing_bounds_refuse_the_debug_frame_but_not_screenshot() {
    for (has_frame, expected_drawable) in [(true, FRAME), (false, CLIENT)] {
        let rig = Rig::standard();
        if !has_frame {
            rig.grabber.describe_as(
                CLIENT,
                vec![Drawn {
                    rect: extents(100, 138, 1000, 700),
                    parent: None,
                    state: 0,
                }],
            );
        }
        rig.lookup.resolved.set(vec![Some(window_info(None))]);
        capture(&rig.env(), &target(), false, deadline()).expect("captured");
        assert_eq!(rig.grabber.last_grab().0, expected_drawable);
        assert_eq!(rig.grabber.grab_count(), 1);

        let strict = Rig::standard();
        if !has_frame {
            strict.grabber.describe_as(
                CLIENT,
                vec![Drawn {
                    rect: extents(100, 138, 1000, 700),
                    parent: None,
                    state: 0,
                }],
            );
        }
        strict.lookup.resolved.set(vec![Some(window_info(None))]);
        let error = capture(&strict.env(), &target(), true, deadline()).expect_err("unproven");
        assert_eq!(error.code, ErrorCode::ActionFailed);
        assert_eq!(strict.grabber.grab_count(), 0);
    }
}

#[test]
fn bounds_that_fit_the_frame_return_the_frame_to_the_debug_capture() {
    let rig = Rig::standard();
    let image = capture(&rig.env(), &target(), true, deadline()).expect("captured");
    assert_eq!(rig.grabber.last_grab().0, FRAME);
    assert_eq!(image.width, 1002);
}

#[test]
fn bounds_that_fit_only_the_client_pick_the_client() {
    let rig = Rig::standard();
    let fitting_client = Some(Rect {
        x: 100.0,
        y: 138.0,
        width: 1000.0,
        height: 700.0,
    });
    rig.lookup
        .resolved
        .set(vec![Some(window_info(fitting_client))]);
    capture(&rig.env(), &target(), true, deadline()).expect("captured");
    assert_eq!(rig.grabber.last_grab().0, CLIENT);
}

fn rig_with_window_of(side: i32) -> Rig {
    let rig = Rig::standard();
    rig.grabber.describe_as(
        FRAME,
        vec![Drawn {
            rect: extents(0, 0, side, side),
            parent: None,
            state: 0,
        }],
    );
    let bounds = Some(Rect {
        x: 0.0,
        y: 0.0,
        width: f64::from(side),
        height: f64::from(side),
    });
    rig.lookup.resolved.set(vec![Some(window_info(bounds))]);
    rig
}

#[test]
fn an_image_over_the_pixel_cap_is_refused_before_the_grab() {
    let over = rig_with_window_of(9_000);
    let error = capture(&over.env(), &target(), false, deadline()).expect_err("too large");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.message, "The window is too large to capture");
    assert_eq!(
        error.suggestion.as_deref(),
        Some("Make the window smaller, then retry")
    );
    assert_eq!(over.grabber.grab_count(), 0);

    let at_cap = rig_with_window_of(8_192);
    *at_cap.grabber.grab_with.lock().expect("grab lock") = Box::new(|_, _| {
        Ok(raw_of(crate::system::x11::capture::grab_rect::GrabRect {
            x: 0,
            y: 0,
            width: 16,
            height: 16,
        }))
    });
    capture(&at_cap.env(), &target(), false, deadline()).expect("captured at the cap");
    assert_eq!(at_cap.grabber.grab_count(), 1);
    assert_eq!(at_cap.grabber.last_grab().1, (0, 0, 8_192, 8_192));
}

fn two_displays() -> Vec<agent_desktop_core::DisplayInfo> {
    vec![
        display_at("left", 0.0, 1920.0, 1.0, true),
        display_at("right", 1920.0, 1920.0, 2.0, false),
    ]
}

#[test]
fn the_scale_comes_from_the_display_with_the_largest_overlap() {
    let rig = Rig::standard();
    rig.lookup.displays.set(vec![Some(two_displays())]);
    let straddling = Some(Rect {
        x: 1800.0,
        y: 100.0,
        width: 1000.0,
        height: 737.0,
    });
    rig.lookup.resolved.set(vec![Some(window_info(straddling))]);
    let image = capture(&rig.env(), &target(), false, deadline()).expect("captured");
    assert!((image.scale_factor - 2.0).abs() < f64::EPSILON);
}

#[test]
fn the_scale_is_one_when_displays_are_unavailable() {
    let rig = Rig::standard();
    rig.lookup.displays.set(vec![None]);
    let image = capture(&rig.env(), &target(), false, deadline()).expect("captured");
    assert!((image.scale_factor - 1.0).abs() < f64::EPSILON);
}
