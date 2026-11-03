use agent_desktop_core::{DeliverySemantics, ErrorCode};

use super::*;
use crate::system::capture::window::fakes::*;
use crate::system::capture::window_xid::XidOutcome;
use crate::system::x11::capture::grab_error::GrabError;
use crate::system::x11::stacking::stacking_read::StackingRead;

fn x11() -> Route {
    Route::X11(":0".to_owned())
}

#[test]
fn a_window_on_a_wayland_session_is_unsupported_and_touches_no_x11() {
    let rig = Rig::standard();
    let error = capture_with(
        &rig.env(),
        &Route::Wayland,
        ScreenshotTarget::ExactWindow(target()),
        deadline(),
    )
    .expect_err("unsupported");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(error.suggestion.is_some());
    assert_eq!(rig.x11_touched(), 0);
}

#[test]
fn the_debug_frame_on_a_wayland_session_is_unsupported_and_touches_no_x11() {
    let rig = Rig::standard();
    let error = capture_frame_with(&rig.env(), &Route::Wayland, &target(), deadline())
        .expect_err("unsupported");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert_eq!(rig.x11_touched(), 0);
}

type Tweak = fn(&Rig);

fn rows() -> Vec<(&'static str, Tweak, ScreenshotTarget)> {
    let window = || ScreenshotTarget::ExactWindow(target());
    vec![
        (
            "ambiguous",
            |rig| rig.lookup.xids.set(vec![XidOutcome::Several(vec![1, 2])]),
            window(),
        ),
        (
            "no client",
            |rig| rig.lookup.xids.set(vec![XidOutcome::NoClient]),
            window(),
        ),
        (
            "no manager",
            |rig| rig.lookup.xids.set(vec![XidOutcome::NoManager]),
            window(),
        ),
        (
            "stale xid",
            |rig| {
                rig.lookup
                    .xids
                    .set(vec![XidOutcome::One(CLIENT), XidOutcome::One(9)])
            },
            window(),
        ),
        (
            "unresolvable",
            |rig| rig.lookup.resolved.set(vec![None]),
            window(),
        ),
        (
            "covered",
            |rig| {
                rig.stacking.reads.set(vec![snapshot(
                    vec![
                        stacked(CLIENT, extents(101, 138, 1000, 700)),
                        stacked(11, extents(500, 400, 100, 100)),
                    ],
                    Vec::new(),
                )]);
            },
            window(),
        ),
        (
            "off screen",
            |rig| {
                *rig.grabber.grab_with.lock().expect("grab lock") =
                    Box::new(|_, _| Err(GrabError::OffScreen));
            },
            window(),
        ),
        (
            "resource",
            |rig| {
                *rig.grabber.grab_with.lock().expect("grab lock") =
                    Box::new(|_, _| Err(GrabError::Resource));
            },
            window(),
        ),
        (
            "timeout",
            |rig| {
                *rig.grabber.grab_with.lock().expect("grab lock") =
                    Box::new(|_, _| Err(GrabError::Timeout));
            },
            window(),
        ),
        (
            "unknown stacking",
            |rig| rig.stacking.reads.set(vec![StackingRead::NotX11]),
            window(),
        ),
        ("display out of range", |_| {}, ScreenshotTarget::Screen(4)),
    ]
}

#[test]
fn every_refusal_leaves_the_call_not_delivered() {
    for (name, tweak, requested) in rows() {
        let rig = Rig::standard();
        tweak(&rig);
        let error = capture_with(&rig.env(), &x11(), requested, deadline()).expect_err(name);
        assert_eq!(
            error.disposition,
            DeliverySemantics::not_delivered(),
            "{name}"
        );
    }
}

#[test]
fn a_window_without_an_instance_token_is_invalid_and_not_delivered() {
    let rig = Rig::standard();
    let mut window = target();
    window.process_instance = None;
    let error = capture_with(
        &rig.env(),
        &x11(),
        ScreenshotTarget::ExactWindow(window),
        deadline(),
    )
    .expect_err("refused");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(rig.x11_touched(), 0);
}

#[test]
fn a_disposition_an_inner_error_already_set_is_kept() {
    let kept = AdapterError::internal("x").with_disposition(DeliverySemantics::uncertain());
    assert_eq!(
        not_delivered(kept).disposition,
        DeliverySemantics::uncertain()
    );
}

#[test]
fn the_grab_error_codes_match_the_table() {
    let cases: [(fn() -> GrabError, ErrorCode); 4] = [
        (|| GrabError::Gone, ErrorCode::StaleRef),
        (|| GrabError::Resource, ErrorCode::ActionFailed),
        (|| GrabError::OffScreen, ErrorCode::ActionFailed),
        (|| GrabError::Timeout, ErrorCode::Timeout),
    ];
    for (make, code) in cases {
        let rig = Rig::standard();
        *rig.grabber.grab_with.lock().expect("grab lock") = Box::new(move |_, _| Err(make()));
        let error = capture_with(
            &rig.env(),
            &x11(),
            ScreenshotTarget::ExactWindow(target()),
            deadline(),
        )
        .expect_err("failed");
        assert_eq!(error.code, code);
    }
}

#[test]
fn the_wayland_route_waits_for_a_person_whatever_the_command_deadline_is() {
    for command_ms in [1, 5_000] {
        let seen = std::cell::Cell::new(None);
        let portal = |_: &ScreenshotTarget, given: Deadline| {
            seen.set(Some(given.remaining()));
            Err(AdapterError::new(ErrorCode::Timeout, "stub"))
        };
        let rig = Rig::standard();
        let command = Deadline::after(command_ms).expect("a deadline");
        let _ = capture_through(
            &rig.env(),
            &Route::Wayland,
            ScreenshotTarget::FullScreen,
            command,
            &portal,
        );
        let waited = seen.get().expect("the portal was called");
        assert!(
            waited > std::time::Duration::from_millis(CONSENT_BUDGET_MS - 2_000),
            "{command_ms} ms gave {waited:?}"
        );
    }
}
