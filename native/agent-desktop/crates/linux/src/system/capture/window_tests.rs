use agent_desktop_core::ErrorCode;

use super::fakes::*;
use super::*;
use crate::system::capture::window_xid::XidOutcome;
use crate::system::x11::capture::grab_error::GrabError;

fn reason_of(error: &AdapterError) -> Option<&str> {
    error
        .details
        .as_ref()
        .and_then(|details| details["reason"].as_str())
}

#[test]
fn a_window_without_a_process_instance_is_refused_before_any_x11_call() {
    let rig = Rig::standard();
    let mut window = target();
    window.process_instance = None;
    let error = capture(&rig.env(), &window, false, deadline()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(rig.x11_touched(), 0);
}

#[test]
fn a_standard_window_is_grabbed_as_its_frame_at_its_own_origin() {
    let rig = Rig::standard();
    let image = capture(&rig.env(), &target(), false, deadline()).expect("captured");
    let (drawable, rect) = rig.grabber.last_grab();
    assert_eq!(drawable, FRAME);
    assert_eq!(rect, (0, 0, 1002, 739));
    assert_eq!((image.width, image.height), (1002, 739));
}

#[test]
fn several_clients_are_ambiguous_with_the_candidate_count() {
    let rig = Rig::standard();
    rig.lookup.xids.set(vec![XidOutcome::Several(vec![1, 2])]);
    let error = capture(&rig.env(), &target(), false, deadline()).expect_err("ambiguous");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details["candidates"].as_u64()),
        Some(2)
    );
    assert_eq!(rig.grabber.grab_count(), 0);
}

#[test]
fn no_client_and_no_manager_keep_their_codes() {
    for (outcome, code) in [
        (XidOutcome::NoClient, ErrorCode::ActionFailed),
        (XidOutcome::NoManager, ErrorCode::PlatformNotSupported),
        (XidOutcome::Unavailable, ErrorCode::PlatformNotSupported),
    ] {
        let rig = Rig::standard();
        rig.lookup.xids.set(vec![outcome]);
        let error = capture(&rig.env(), &target(), false, deadline()).expect_err("refused");
        assert_eq!(error.code, code);
    }
}

#[test]
fn a_different_xid_after_the_grab_is_stale_and_returns_no_image() {
    let rig = Rig::standard();
    rig.lookup
        .xids
        .set(vec![XidOutcome::One(CLIENT), XidOutcome::One(99)]);
    let error = capture(&rig.env(), &target(), false, deadline()).expect_err("stale");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(rig.grabber.grab_count(), 1);
}

#[test]
fn the_same_xid_with_a_moved_frame_after_the_grab_is_stale() {
    let rig = Rig::standard();
    let before = Drawn {
        rect: extents(100, 100, 1002, 739),
        parent: None,
        state: 0,
    };
    let after = Drawn {
        rect: extents(300, 100, 1002, 739),
        ..before.clone()
    };
    rig.grabber.describe_as(FRAME, vec![before, after]);
    let error = capture(&rig.env(), &target(), false, deadline()).expect_err("stale");
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn a_window_that_cannot_be_resolved_after_the_grab_is_the_resolvers_error() {
    let rig = Rig::standard();
    rig.lookup
        .resolved
        .set(vec![Some(window_info(frame_bounds())), None]);
    let error = capture(&rig.env(), &target(), false, deadline()).expect_err("gone");
    assert_eq!(error.code, ErrorCode::WindowNotFound);
}

#[test]
fn a_window_that_closes_during_the_grab_is_stale() {
    let rig = Rig::standard();
    *rig.grabber.grab_with.lock().expect("grab lock") = Box::new(|_, _| Err(GrabError::Gone));
    let error = capture(&rig.env(), &target(), false, deadline()).expect_err("stale");
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn a_viewable_window_the_server_cannot_read_is_off_screen_not_minimised() {
    let rig = Rig::standard();
    *rig.grabber.grab_with.lock().expect("grab lock") = Box::new(|_, _| Err(GrabError::OffScreen));
    let error = capture(&rig.env(), &target(), false, deadline()).expect_err("off screen");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(reason_of(&error), Some("off_screen"));
}

#[test]
fn an_unmapped_window_names_the_missing_compositor_and_asks_for_a_restore() {
    for compositing in [false, true] {
        let rig = Rig::standard();
        if compositing {
            rig.compose_on();
        }
        rig.grabber.describe_as(
            CLIENT,
            vec![Drawn {
                rect: extents(1, 38, 1000, 700),
                parent: Some(FRAME),
                state: 2,
            }],
        );
        let error = capture(&rig.env(), &target(), false, deadline()).expect_err("minimised");
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(
            error.message.contains("does not composite"),
            !compositing,
            "{}",
            error.message
        );
        assert!(
            error
                .suggestion
                .as_deref()
                .is_some_and(|text| text.contains("restore")),
            "{:?}",
            error.suggestion
        );
        assert_eq!(rig.grabber.grab_count(), 0);
    }
}

#[test]
fn a_stopped_process_is_app_unresponsive_before_any_x11_call() {
    let mut rig = Rig::standard();
    rig.stopped = always_stopped;
    let error = capture(&rig.env(), &target(), false, deadline()).expect_err("stopped");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(error.message.contains("editor"), "{}", error.message);
    let details = error.details.expect("details");
    assert_eq!(details["pid"].as_u64(), Some(4));
    assert_eq!(details["process_instance"].as_str(), Some("instance"));
    assert_eq!(rig.x11_touched(), 0);
}

#[test]
fn a_client_side_shadow_is_cropped_from_the_captured_client_area() {
    let rig = Rig::standard();
    rig.grabber.shadow_as(
        CLIENT,
        FrameExtents {
            left: 14,
            right: 14,
            top: 10,
            bottom: 24,
        },
    );
    let area = Some(agent_desktop_core::Rect {
        x: 15.0,
        y: 48.0,
        width: 972.0,
        height: 666.0,
    });
    rig.lookup.resolved.set(vec![Some(window_info(area))]);
    let image = capture(&rig.env(), &target(), false, deadline()).expect("captured");
    let (drawable, rect) = rig.grabber.last_grab();
    assert_eq!(drawable, CLIENT);
    assert_eq!(rect, (14, 10, 972, 666));
    assert_eq!((image.width, image.height), (972, 666));
}

#[test]
fn an_invalid_shadow_is_ignored() {
    let rect = extents(0, 0, 20, 20);
    for shadow in [
        FrameExtents {
            left: 10,
            right: 10,
            top: 0,
            bottom: 0,
        },
        FrameExtents {
            left: 1_000,
            right: i32::MAX as u32,
            top: 0,
            bottom: 0,
        },
        FrameExtents {
            left: 0,
            right: 0,
            top: 1_000,
            bottom: i32::MAX as u32,
        },
    ] {
        assert_eq!(inside_shadow(rect, Some(shadow)), (rect, (0, 0)));
    }
}
