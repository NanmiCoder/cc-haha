use crate::system::capture::capture_backend::test_hooks as backend_hooks;
use crate::system::capture::capture_modern::{interop_is_available, modern_is_supported};
use crate::system::capture::capture_window::capture_window;
use crate::system::capture::png_codec::decode_png_to_bgra;
use crate::tree::fixture::fixture_pattern::{class_still_registered, window_still_exists};
use crate::tree::fixture::{LocalPatternFixture, bootstrap};

/// On-screen pattern staging follows the same opt-in as the ScratchWpf live
/// legs so a developer suite does not gain a window unasked; CI sets it.
const LIVE_STAGE_VARIABLE: &str = "AGENT_DESKTOP_LIVE_WPF";

use crate::system::fixture::test_time::deadline;

use crate::system::capture::capture_test_support::{live_graphics_capture_lock, sample_rgb};

fn skip_unless_live_staging(reason: &str) -> bool {
    if std::env::var_os(LIVE_STAGE_VARIABLE).is_none() {
        eprintln!(
            "skip {reason}: {LIVE_STAGE_VARIABLE} is unset here, so no on-screen pattern fixture was staged; the Test (Windows) CI lane sets it and owns executing this"
        );
        return true;
    }
    false
}

fn skip_if_modern_interop_unavailable(reason: &str) -> bool {
    if !modern_is_supported() {
        eprintln!("skip {reason}: GraphicsCaptureSession::IsSupported is false");
        return true;
    }
    if !interop_is_available() {
        eprintln!(
            "skip {reason}: IsSupported true but IGraphicsCaptureItemInterop unavailable on this host (A22-1 / build 17763)"
        );
        return true;
    }
    false
}

fn assert_pattern_samples(bgra: &[u8], width: u32, fixture: &LocalPatternFixture) {
    let expectation = fixture.expectation();
    let mut samples = [[0u8; 3]; 4];
    for (index, point) in expectation.sample_points().into_iter().enumerate() {
        samples[index] = sample_rgb(bgra, width, point.x, point.y);
    }
    assert!(
        expectation.matches_samples(&samples),
        "captured samples {samples:?} must match {:?}",
        expectation.sample_points()
    );
    let mut mutated = expectation;
    mutated.colors.top_left = [0x01, 0x02, 0x03];
    assert!(
        !mutated.matches_samples(&samples),
        "mutating one painted quadrant must make the capture assertion fail"
    );
}

#[test]
fn live_legacy_pattern_fixture_matches_and_invert_fails_when_stageable() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    if skip_unless_live_staging("legacy pattern capture") {
        return;
    }
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let handle = fixture.handle();
    let class_name = fixture.class_name().to_owned();

    let image = backend_hooks::with_force_unsupported(|| {
        capture_window(handle as _, 1.0, deadline(10_000))
    })
    .expect("legacy PrintWindow of the pattern fixture");
    let (bgra, width, _height) =
        decode_png_to_bgra(&image.data, deadline(10_000)).expect("decode captured PNG");
    assert_pattern_samples(&bgra, width, &fixture);

    drop(fixture);
    assert!(
        !window_still_exists(handle),
        "pattern window must be gone after the live leg"
    );
    assert!(
        !class_still_registered(&class_name),
        "pattern class must be unregistered after the live leg"
    );
}

#[test]
fn live_modern_pattern_fixture_matches_when_supported_and_stageable() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    if skip_unless_live_staging("modern pattern capture") {
        return;
    }
    if skip_if_modern_interop_unavailable("modern pattern capture") {
        return;
    }
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let handle = fixture.handle();
    let class_name = fixture.class_name().to_owned();

    let image =
        crate::system::capture::capture_modern::capture_window(handle as _, 1.0, deadline(10_000))
            .expect("WGC window capture of the pattern fixture");
    let (bgra, width, _height) =
        decode_png_to_bgra(&image.data, deadline(10_000)).expect("decode captured PNG");
    assert_pattern_samples(&bgra, width, &fixture);

    drop(fixture);
    assert!(!window_still_exists(handle));
    assert!(!class_still_registered(&class_name));
}

#[test]
fn live_capture_breadth_leaves_no_orphan_window_after_drop() {
    bootstrap();
    if skip_unless_live_staging("orphan-window re-observation") {
        return;
    }
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let handle = fixture.handle();
    assert!(window_still_exists(handle));
    drop(fixture);
    assert!(
        !window_still_exists(handle),
        "independent re-observation must see the fixture window gone"
    );
}
