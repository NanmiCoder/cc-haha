use super::{
    bare_retry_observed, capture_window, fail_after_alloc, fail_after_fullcontent, gdi_balance,
};
use crate::system::capture::png_codec::decode_png_to_bgra;
use crate::tree::fixture::{LocalPatternFixture, StalledFixture, bootstrap};
use agent_desktop_core::{Deadline, ErrorCode};
use std::time::Duration;

use crate::system::fixture::test_time::deadline;

use crate::system::capture::capture_test_support::live_graphics_capture_lock;
use crate::system::capture::capture_test_support::sample_rgb;

#[test]
fn pattern_fixture_capture_matches_sampled_colours() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let fixture = LocalPatternFixture::create().expect("pattern fixture starts");
    let image = capture_window(fixture.handle() as _, 1.0, deadline(10_000))
        .expect("PrintWindow capture of the pattern fixture succeeds");

    let (bgra, width, height) =
        decode_png_to_bgra(&image.data, deadline(10_000)).expect("decode captured PNG");
    assert_eq!((width, height), (image.width, image.height));

    let expectation = fixture.expectation();
    let mut samples = [[0u8; 3]; 4];
    for (index, point) in expectation.sample_points().into_iter().enumerate() {
        samples[index] = sample_rgb(&bgra, width, point.x, point.y);
    }
    assert!(
        expectation.matches_samples(&samples),
        "captured samples {samples:?} must match {:?}",
        expectation.sample_points()
    );
}

#[test]
fn stalled_fixture_returns_app_unresponsive_without_hanging() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let stalled = StalledFixture::create().expect("stalled fixture starts");
    let started = std::time::Instant::now();
    let error = capture_window(stalled.handle() as _, 1.0, deadline(10_000))
        .expect_err("a non-pumping window must be refused before PrintWindow");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the pump probe must bound the refusal, elapsed {:?}",
        started.elapsed()
    );
}

/// Callers corroborate identity before [`capture_window`]. This module then
/// refuses a destroyed handle before the pump probe, so a gone window is
/// reported as a stale-identity style miss rather than `APP_UNRESPONSIVE`.
#[test]
fn destroyed_handle_is_not_reported_unresponsive() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let fixture = LocalPatternFixture::create().expect("pattern fixture starts");
    let handle = fixture.handle();
    drop(fixture);
    assert!(
        !crate::tree::automation::window_exists(handle),
        "fixture drop must destroy the window before the capture call"
    );

    let error = capture_window(handle as _, 1.0, deadline(10_000))
        .expect_err("a destroyed handle must fail closed");
    assert_ne!(
        error.code,
        ErrorCode::AppUnresponsive,
        "existence is checked before the pump probe"
    );
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn printwindow_access_denied_maps_to_perm_denied() {
    unsafe { windows_sys::Win32::Foundation::SetLastError(5) };
    let error = super::win32_last_error("PrintWindow failed");
    assert_eq!(error.code, ErrorCode::PermDenied);
    assert!(
        error
            .platform_detail
            .as_deref()
            .is_some_and(|detail| detail.contains("0x80070005"))
    );
}

#[test]
fn minimized_windows_are_rejected_before_bitmap_alloc() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    gdi_balance::reset();
    let fixture = LocalPatternFixture::create().expect("pattern fixture starts");
    let handle = fixture.handle() as windows_sys::Win32::Foundation::HWND;

    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(
            handle,
            windows_sys::Win32::UI::WindowsAndMessaging::SW_MINIMIZE,
        );
    }
    std::thread::sleep(Duration::from_millis(50));

    let before = gdi_balance::live();
    let error = capture_window(handle, 1.0, deadline(10_000))
        .expect_err("minimized windows are rejected before PrintWindow");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        gdi_balance::live(),
        before,
        "rejection must not allocate GDI objects"
    );
}

#[test]
fn oversized_dimensions_are_rejected_while_ordinary_dimensions_are_accepted() {
    let oversized = crate::system::capture::gdi_surface::reject_oversized_capture(23171, 23171)
        .expect_err("a window whose pixel byte count overflows i32 must be refused");
    assert_eq!(oversized.code, ErrorCode::InvalidArgs);

    crate::system::capture::gdi_surface::reject_oversized_capture(1920, 1080)
        .expect("an ordinary window size must still be accepted");
}

#[test]
fn gdi_objects_balance_across_success_deadline_and_forced_failure() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    gdi_balance::reset();
    let fixture = LocalPatternFixture::create().expect("pattern fixture starts");
    let handle = fixture.handle() as _;

    let _ = capture_window(handle, 1.0, deadline(10_000)).expect("success path");
    assert_eq!(
        gdi_balance::live(),
        0,
        "success path must release every GDI object"
    );

    let expired = Deadline::after(1).expect("tiny deadline");
    std::thread::sleep(Duration::from_millis(5));
    let timeout = capture_window(handle, 1.0, expired).expect_err("expired deadline");
    assert_eq!(timeout.code, ErrorCode::Timeout);
    assert_eq!(
        gdi_balance::live(),
        0,
        "early deadline abort allocates nothing"
    );

    let forced = fail_after_alloc::with(|| capture_window(handle, 1.0, deadline(10_000)))
        .expect_err("forced failure after allocation");
    assert_eq!(forced.code, ErrorCode::ActionFailed);
    assert_eq!(
        gdi_balance::live(),
        0,
        "forced failure must still Drop every GDI object"
    );
}

#[test]
fn printwindow_retries_with_bare_flags_when_fullcontent_path_is_skipped() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let fixture = LocalPatternFixture::create().expect("pattern fixture starts");
    bare_retry_observed::reset();
    let image = fail_after_fullcontent::with(|| {
        capture_window(fixture.handle() as _, 1.0, deadline(10_000))
    })
    .expect("bare PrintWindow retry must succeed on the pattern fixture");
    assert!(
        bare_retry_observed::take(),
        "removing the bare-flags fallback leaves this path untested and breaks invert verification"
    );

    let (bgra, width, height) =
        decode_png_to_bgra(&image.data, deadline(10_000)).expect("decode captured PNG");
    assert_eq!((width, height), (image.width, image.height));
    let expectation = fixture.expectation();
    let mut samples = [[0u8; 3]; 4];
    for (index, point) in expectation.sample_points().into_iter().enumerate() {
        samples[index] = sample_rgb(&bgra, width, point.x, point.y);
    }
    assert!(
        expectation.matches_samples(&samples),
        "fallback capture must still match fixture colours, got {samples:?}"
    );
}
