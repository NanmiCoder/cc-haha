use super::imp::{
    display_args, map_screencapture_error, run_screencapture, validate_pixel_count,
    validate_png_size, verify_display_identity, window_args,
};
use agent_desktop_core::{Deadline, DisplayInfo, ErrorCode, Rect};
use std::ffi::OsString;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{Command, ExitStatus, Output};

fn output(stderr: &str) -> Output {
    Output {
        status: ExitStatus::from_raw(1 << 8),
        stdout: Vec::new(),
        stderr: stderr.as_bytes().to_vec(),
    }
}

#[test]
fn maps_screen_recording_error_to_permission_denied() {
    let err = map_screencapture_error(&output("Screen Recording is not authorized"));

    assert_eq!(err.code, ErrorCode::PermDenied);
    assert!(err.suggestion.is_some());
}

#[test]
fn maps_unknown_screencapture_error_to_internal() {
    let err = map_screencapture_error(&output("display server unavailable"));

    assert_eq!(err.code, ErrorCode::Internal);
    assert_eq!(
        err.platform_detail.as_deref(),
        Some("display server unavailable")
    );
}

#[test]
fn run_screencapture_kills_timed_out_process() {
    let mut command = Command::new("/bin/sleep");
    command.arg("10");

    let deadline = Deadline::after(20).expect("deadline");
    let err = run_screencapture(&mut command, deadline).unwrap_err();

    assert_eq!(err.code, ErrorCode::Timeout);
}

#[test]
fn display_argv_uses_one_based_display_selector_without_a_rect() {
    let args = display_args(1, Path::new("/tmp/capture.png")).expect("display args");

    assert_eq!(
        args,
        ["-x", "-t", "png", "-D", "2", "/tmp/capture.png"].map(OsString::from)
    );
    assert!(!args.contains(&OsString::from("-R")));
}

#[test]
fn window_argv_keeps_the_requested_cg_window_number() {
    let args = window_args(314, Path::new("/tmp/capture.png"));

    assert_eq!(
        args,
        ["-x", "-t", "png", "-l", "314", "/tmp/capture.png"].map(OsString::from)
    );
}

#[test]
fn display_identity_mismatch_is_rejected() {
    let expected = display("100", 2.0);
    let current = display("200", 1.0);

    let error =
        verify_display_identity(1, &expected, &current).expect_err("changed display identity");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(error.message.contains("100"));
    assert!(error.message.contains("200"));
}

#[test]
fn rejects_png_payloads_outside_the_bounded_size_range() {
    let too_small = validate_png_size(23).expect_err("short PNG");
    let too_large = validate_png_size(64 * 1024 * 1024 + 1).expect_err("large PNG");

    assert_eq!(too_small.code, ErrorCode::ActionFailed);
    assert_eq!(too_large.code, ErrorCode::ActionFailed);
}

#[test]
fn rejects_images_outside_the_bounded_pixel_range() {
    let zero = validate_pixel_count(0, 100).expect_err("zero-width image");
    let too_large = validate_pixel_count(10_001, 10_001).expect_err("large image");

    assert_eq!(zero.code, ErrorCode::ActionFailed);
    assert_eq!(too_large.code, ErrorCode::ActionFailed);
}

fn display(id: &str, scale: f64) -> DisplayInfo {
    DisplayInfo {
        id: id.into(),
        bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        },
        is_primary: id == "100",
        scale,
    }
}
