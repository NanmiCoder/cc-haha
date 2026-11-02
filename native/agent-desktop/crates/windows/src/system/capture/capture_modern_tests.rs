use super::{
    capture_display, capture_window, fail_after_start, hold_frames, interop_is_available,
    modern_is_supported,
};
use crate::system::capture::capture_backend::{self, CaptureSubject};
use crate::system::capture::capture_d3d::resource_balance;
use crate::system::capture::png_codec::decode_png_to_bgra;
use crate::system::display::{display_at, list_displays_live};
use crate::system::permissions::report;
use crate::tree::fixture::{LocalPatternFixture, bootstrap};
use agent_desktop_core::{ErrorCode, PermissionState};
use windows::Graphics::Capture::GraphicsCaptureSession;

use crate::system::fixture::test_time::deadline;

use crate::system::capture::capture_test_support::{live_graphics_capture_lock, sample_rgb};

const HELD_FRAME_BUDGET_MS: usize = 50;
const PATTERN_PAINT_WAIT_MS: u64 = 5_000;

/// Pixel and resource-balance legs need the HWND/HMONITOR interop, which is a
/// stricter gate than [`modern_is_supported`] (A22-1: IsSupported can be true
/// while `IGraphicsCaptureItemInterop` QI still fails).
fn skip_if_interop_unavailable(reason: &str) -> bool {
    if !modern_is_supported() {
        eprintln!("skip: {reason} (GraphicsCaptureSession::IsSupported is false)");
        return true;
    }
    if !interop_is_available() {
        eprintln!(
            "skip: {reason} (IsSupported true but IGraphicsCaptureItemInterop unavailable — A22-1)"
        );
        return true;
    }
    false
}

#[test]
fn support_predicate_is_the_capture_api_answer_and_stable_within_a_process() {
    bootstrap();
    let direct = GraphicsCaptureSession::IsSupported().unwrap_or(false);
    assert_eq!(
        modern_is_supported(),
        direct,
        "the predicate must be the capture API's own answer, not a build-number guess"
    );
    assert_eq!(
        modern_is_supported(),
        direct,
        "IsSupported must be stable for the process"
    );
}

#[test]
fn unsupported_host_reports_unavailable_without_capture_api() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    if modern_is_supported() {
        eprintln!(
            "skip: host reports WGC supported via IsSupported; unavailable-without-API leg needs an unsupported session"
        );
        return;
    }
    resource_balance::reset();
    let fixture = LocalPatternFixture::create().expect("pattern fixture starts");
    let error = capture_window(fixture.handle() as _, 1.0, deadline(10_000))
        .expect_err("unsupported host must refuse before capture work");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(
        resource_balance::live(),
        0,
        "unsupported path must not create tracked resources"
    );
}

/// A first WGC frame can precede the window being composited, so the capture
/// is repeated until a frame shows the fixture's pattern rather than after a
/// fixed pause. Uniform black alone cannot distinguish session compositing
/// from capture failure; GDI independently verifies the window painted, making
/// black that outlasts the wait a failure and not a skip.
#[test]
fn pattern_fixture_window_capture_matches_when_supported() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    if skip_if_interop_unavailable("pattern window capture") {
        return;
    }
    let fixture = LocalPatternFixture::create().expect("pattern fixture starts");
    let expectation = fixture.expectation();
    let paint_wait = deadline(PATTERN_PAINT_WAIT_MS);
    let mut samples = [[0u8; 3]; 4];
    loop {
        let image = capture_window(fixture.handle() as _, 1.0, deadline(10_000))
            .expect("WGC window capture of the pattern fixture succeeds");
        let (bgra, width, height) =
            decode_png_to_bgra(&image.data, deadline(10_000)).expect("decode captured PNG");
        assert_eq!((width, height), (image.width, image.height));
        for (index, point) in expectation.sample_points().into_iter().enumerate() {
            samples[index] = sample_rgb(&bgra, width, point.x, point.y);
        }
        if expectation.matches_samples(&samples) || paint_wait.is_expired() {
            break;
        }
    }
    if samples.iter().all(|sample| *sample == [0u8; 3]) {
        match fixture.blit_client_samples() {
            Ok(gdi) if expectation.matches_samples(&gdi) => {
                panic!(
                    "window capture returned uniform black while GDI read the expected \
                     pattern from the same client area ({gdi:?}); the window painted, so \
                     this is a capture defect rather than a session without a compositor"
                );
            }
            _ => {
                eprintln!(
                    "skip: neither the capture path nor an independent GDI read of the \
                     same client area produced pixels; this session composites nothing, \
                     so color matching cannot be evaluated here"
                );
                return;
            }
        }
    }
    assert!(
        expectation.matches_samples(&samples),
        "captured samples {samples:?} must match {:?}",
        expectation.sample_points()
    );
}

#[test]
fn monitor_capture_returns_monitor_dimensions_when_supported() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    if skip_if_interop_unavailable("monitor capture") {
        return;
    }
    let primary = display_at(0, deadline(10_000)).expect("primary display");
    let image = capture_display(0, deadline(10_000)).expect("WGC monitor capture succeeds");
    assert_eq!(
        (image.width, image.height),
        (primary.bounds.width as u32, primary.bounds.height as u32)
    );
    assert_eq!(image.scale_factor, primary.scale);
}

#[test]
fn frame_wait_deadline_expiry_falls_back_to_legacy() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    if skip_if_interop_unavailable("frame-wait deadline expiry") {
        return;
    }
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let modern_error = hold_frames::with(HELD_FRAME_BUDGET_MS, || {
        capture_window(fixture.handle() as _, 1.0, deadline(10_000))
    })
    .expect_err("holding frames past the frame-wait budget must fail the modern backend");
    assert_eq!(modern_error.code, ErrorCode::Timeout);
    assert_eq!(
        modern_error
            .details
            .as_ref()
            .and_then(|details| details.get("timeout_ms"))
            .and_then(serde_json::Value::as_u64),
        Some(HELD_FRAME_BUDGET_MS as u64),
        "the Timeout must come from the frame-wait budget, not from the caller's deadline"
    );

    let image = hold_frames::with(HELD_FRAME_BUDGET_MS, || {
        capture_backend::capture_with_precedence(
            CaptureSubject::Window {
                handle: fixture.handle() as _,
                scale_factor: 1.0,
            },
            deadline(10_000),
        )
    })
    .expect("precedence must still succeed via Legacy after a modern timeout");
    assert!(!image.data.is_empty());
}

#[test]
fn interop_failure_is_backend_failure_that_precedence_recovers() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    if !modern_is_supported() {
        eprintln!("skip: interop-failure fallback needs IsSupported true");
        return;
    }
    if interop_is_available() {
        eprintln!(
            "skip: interop is available on this host; E_NOINTERFACE recovery is exercised on A22-1 hosts"
        );
        return;
    }
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let modern_error = capture_window(fixture.handle() as _, 1.0, deadline(10_000))
        .expect_err("missing interop must fail the modern backend");
    assert_ne!(modern_error.code, ErrorCode::Timeout);
    let image = capture_backend::capture_with_precedence(
        CaptureSubject::Window {
            handle: fixture.handle() as _,
            scale_factor: 1.0,
        },
        deadline(10_000),
    )
    .expect("Legacy must recover when modern interop is missing");
    assert!(!image.data.is_empty());
}

#[test]
fn resources_balance_across_success_deadline_and_forced_failure() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    if skip_if_interop_unavailable("resource balance") {
        return;
    }
    resource_balance::reset();
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let handle = fixture.handle() as _;

    let _ = capture_window(handle, 1.0, deadline(10_000)).expect("success path");
    assert_eq!(
        resource_balance::live(),
        0,
        "success path must release every tracked resource"
    );

    let timeout = hold_frames::with(HELD_FRAME_BUDGET_MS, || {
        capture_window(handle, 1.0, deadline(10_000))
    })
    .expect_err("held frames past the frame-wait budget");
    assert_eq!(timeout.code, ErrorCode::Timeout);
    assert_eq!(
        resource_balance::live(),
        0,
        "deadline abort must release every tracked resource"
    );

    let forced = fail_after_start::with(|| capture_window(handle, 1.0, deadline(10_000)))
        .expect_err("forced failure after session start");
    assert_eq!(forced.code, ErrorCode::ActionFailed);
    assert_eq!(
        resource_balance::live(),
        0,
        "forced failure must still Drop every tracked resource"
    );
}

#[test]
fn permission_report_screen_recording_is_honest_when_legacy_can_capture() {
    bootstrap();
    let displays = list_displays_live(deadline(10_000)).expect("displays");
    assert!(!displays.is_empty());
    let report = report(deadline(10_000)).expect("permission report");
    assert_eq!(
        report.screen_recording,
        PermissionState::NotRequired,
        "a session that can list displays can capture via Legacy"
    );
}
