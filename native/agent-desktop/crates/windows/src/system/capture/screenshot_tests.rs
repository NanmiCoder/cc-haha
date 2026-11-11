use super::{capture_window, screenshot, test_hooks as screenshot_hooks};
use crate::system::capture::capture_backend::test_hooks as backend_hooks;
use crate::system::capture::png_codec::decode_png_to_bgra;
use crate::system::display::{display_at, list_displays_live};
use crate::tree::fixture::{LocalPatternFixture, StalledFixture, bootstrap};
use agent_desktop_core::{
    Deadline, DeliveryDisposition, ErrorCode, ImageFormat, ProcessId, ScreenshotTarget, WindowInfo,
    WindowState, parse_png_dimensions,
};

use crate::system::fixture::test_time::deadline;

fn window_info_for(handle: isize, process_instance: Option<String>) -> WindowInfo {
    let pid = ProcessId::from(std::process::id());
    let app = crate::system::process_identity::process_image_name(pid).unwrap_or_default();
    WindowInfo {
        id: format!("w-{}", handle as usize),
        title: String::new(),
        app,
        pid,
        process_instance,
        bounds: None,
        state: WindowState::default(),
    }
}

fn live_token() -> String {
    let pid = ProcessId::from(std::process::id());
    crate::system::process_identity::token_for_pid(pid)
        .expect("token read")
        .expect("live token")
}

use crate::system::capture::capture_test_support::live_graphics_capture_lock;
use crate::system::capture::capture_test_support::sample_rgb;

fn assert_png_metadata(image: &agent_desktop_core::ImageBuffer) {
    assert_eq!(image.format.as_str(), ImageFormat::Png.as_str());
    let (width, height) =
        parse_png_dimensions(&image.data).expect("PNG header must parse for core consumers");
    assert_eq!((width, height), (image.width, image.height));
}

#[test]
fn four_targets_produce_png_buffers_via_legacy_fallback() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    backend_hooks::with_force_unsupported(|| {
        let displays = list_displays_live(deadline(10_000)).expect("enumerate displays");
        let primary = displays
            .iter()
            .find(|display| display.is_primary)
            .expect("primary display");

        let fullscreen =
            screenshot(ScreenshotTarget::FullScreen, deadline(10_000)).expect("FullScreen");
        assert_png_metadata(&fullscreen);
        assert_eq!(
            (fullscreen.width, fullscreen.height),
            (primary.bounds.width as u32, primary.bounds.height as u32)
        );

        let screen = screenshot(ScreenshotTarget::Screen(0), deadline(10_000)).expect("Screen(0)");
        assert_png_metadata(&screen);

        let display = screenshot(
            ScreenshotTarget::Display {
                index: 0,
                expected: primary.clone(),
            },
            deadline(10_000),
        )
        .expect("Display");
        assert_png_metadata(&display);

        let fixture = LocalPatternFixture::create().expect("pattern fixture");
        let info = window_info_for(fixture.handle(), Some(live_token()));
        let window =
            screenshot(ScreenshotTarget::ExactWindow(info), deadline(10_000)).expect("ExactWindow");
        assert_png_metadata(&window);

        let (bgra, width, _height) =
            decode_png_to_bgra(&window.data, deadline(10_000)).expect("decode window PNG");
        let expectation = fixture.expectation();
        let mut samples = [[0u8; 3]; 4];
        for (index, point) in expectation.sample_points().into_iter().enumerate() {
            samples[index] = sample_rgb(&bgra, width, point.x, point.y);
        }
        assert!(
            expectation.matches_samples(&samples),
            "ExactWindow capture must match the pattern fixture"
        );
    });
}

#[test]
fn exact_window_without_process_instance_is_invalid_args_not_delivered() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let info = window_info_for(fixture.handle(), None);
    let error = screenshot(ScreenshotTarget::ExactWindow(info), deadline(10_000))
        .expect_err("missing process_instance must fail before native capture");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );

    let with_token = window_info_for(fixture.handle(), Some(live_token()));
    let image = capture_window(&with_token, deadline(10_000))
        .expect("supplying a token lets ExactWindow proceed");
    assert_png_metadata(&image);
}

#[test]
fn post_capture_window_identity_failure_discards_bytes() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let info = window_info_for(fixture.handle(), Some(live_token()));

    let error = screenshot_hooks::with_force_post_identity_failure(|| {
        screenshot(
            ScreenshotTarget::ExactWindow(info.clone()),
            deadline(10_000),
        )
    })
    .expect_err("post-capture identity failure must discard bytes");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );

    let leaked = screenshot_hooks::with_skip_post_identity(|| {
        screenshot_hooks::with_force_post_identity_failure(|| {
            screenshot(ScreenshotTarget::ExactWindow(info), deadline(10_000))
        })
    })
    .expect("skipping the post-check leaks bytes — invert of the discard guard");
    assert_png_metadata(&leaked);
}

#[test]
fn modern_forced_fail_after_available_falls_back_to_legacy() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    backend_hooks::with_force_fail_after_available(|| {
        let image = screenshot(ScreenshotTarget::Screen(0), deadline(10_000))
            .expect("modern failure must fall back to legacy");
        assert_png_metadata(&image);
    });
}

#[test]
fn modern_slice_reserves_floor_so_legacy_still_succeeds() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let info = window_info_for(fixture.handle(), Some(live_token()));
    let tight = Deadline::after(500).expect("tight deadline");

    let image = backend_hooks::with_force_fail_after_available(|| {
        backend_hooks::with_consume_modern_slice(|| {
            screenshot(ScreenshotTarget::ExactWindow(info.clone()), tight)
        })
    })
    .expect("capped modern burn must leave Legacy enough budget");
    assert_png_metadata(&image);

    let invert_deadline = Deadline::after(500).expect("invert deadline");
    let timed_out = backend_hooks::with_force_fail_after_available(|| {
        backend_hooks::with_consume_modern_slice(|| {
            backend_hooks::with_disable_deadline_slice(|| {
                screenshot(ScreenshotTarget::ExactWindow(info), invert_deadline)
            })
        })
    })
    .expect_err("without the slice cap modern consumes the whole budget");
    assert_eq!(timed_out.code, ErrorCode::Timeout);
    assert_eq!(
        timed_out.disposition.delivery(),
        DeliveryDisposition::NotDelivered,
        "a timed-out capture delivered nothing, so it must not be reported unknown"
    );
}

#[test]
fn window_scale_factor_comes_from_owning_display() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let info = window_info_for(fixture.handle(), Some(live_token()));
    let resolved =
        crate::system::window::window_resolve::resolve_window_strict(&info, deadline(10_000))
            .expect("resolve");
    let expected_scale =
        crate::system::display::scale_for_bounds(resolved.bounds, deadline(10_000))
            .expect("scale for window bounds");

    let image = screenshot(ScreenshotTarget::ExactWindow(info), deadline(10_000)).expect("capture");
    assert_eq!(image.scale_factor, expected_scale);

    let primary = display_at(0, deadline(10_000)).expect("primary");
    let display_image = screenshot(
        ScreenshotTarget::Display {
            index: 0,
            expected: primary.clone(),
        },
        deadline(10_000),
    )
    .expect("display capture");
    assert_eq!(display_image.scale_factor, primary.scale);
}

#[test]
fn window_identity_mismatch_is_not_delivered_through_the_entry_point() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let mut info = window_info_for(fixture.handle(), Some(live_token()));
    info.process_instance = Some("windows-proc-v1:0:0".into());

    let error = screenshot(ScreenshotTarget::ExactWindow(info), deadline(10_000))
        .expect_err("a stale generation token must fail before native capture");
    assert_eq!(error.code, ErrorCode::WindowNotFound);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn display_identity_mismatch_is_not_delivered_through_the_entry_point() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let primary = display_at(0, deadline(10_000)).expect("primary");
    let mut stale = primary.clone();
    stale.bounds.width += 1.0;

    let error = screenshot(
        ScreenshotTarget::Display {
            index: 0,
            expected: stale,
        },
        deadline(10_000),
    )
    .expect_err("a stale display fingerprint must fail before native capture");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn screenshot_entry_upgrades_only_unknown_disposition_to_not_delivered() {
    use agent_desktop_core::{AdapterError, DeliverySemantics};

    let unknown = AdapterError::new(ErrorCode::InvalidArgs, "probe");
    let upgraded = super::coerce_screenshot_disposition_for_test(unknown);
    assert_eq!(upgraded.disposition, DeliverySemantics::not_delivered());

    let already = AdapterError::new(ErrorCode::InvalidArgs, "probe")
        .with_disposition(DeliverySemantics::not_delivered());
    assert_eq!(
        super::coerce_screenshot_disposition_for_test(already).disposition,
        DeliverySemantics::not_delivered()
    );

    for semantics in [
        DeliverySemantics::uncertain(),
        DeliverySemantics::delivered_unverified(),
        DeliverySemantics::delivered_verified(),
    ] {
        let error = AdapterError::new(ErrorCode::ActionFailed, "probe").with_disposition(semantics);
        assert_eq!(
            super::coerce_screenshot_disposition_for_test(error).disposition,
            semantics
        );
    }
}
#[test]
fn invalid_display_index_is_not_delivered_through_the_entry_point() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let error = screenshot(ScreenshotTarget::Screen(9_999), deadline(10_000))
        .expect_err("an out-of-range display index must fail");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn minimized_window_capture_is_not_delivered_through_the_entry_point() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let handle = fixture.handle() as windows_sys::Win32::Foundation::HWND;
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(
            handle,
            windows_sys::Win32::UI::WindowsAndMessaging::SW_MINIMIZE,
        );
    }
    std::thread::sleep(std::time::Duration::from_millis(50));
    let info = window_info_for(fixture.handle(), Some(live_token()));

    let error = backend_hooks::with_force_unsupported(|| {
        screenshot(ScreenshotTarget::ExactWindow(info), deadline(10_000))
    })
    .expect_err("a minimized window must be refused before native capture");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn stalled_window_capture_is_not_delivered_through_the_entry_point() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let stalled = StalledFixture::create().expect("stalled fixture");
    let info = window_info_for(stalled.handle(), Some(live_token()));

    let error = backend_hooks::with_force_unsupported(|| {
        screenshot(ScreenshotTarget::ExactWindow(info), deadline(10_000))
    })
    .expect_err("a non-pumping window must be refused before native capture");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn adapter_screenshot_delegates_to_orchestration() {
    let _capture = live_graphics_capture_lock();
    use agent_desktop_core::SystemOps;

    bootstrap();
    let adapter = crate::adapter::WindowsAdapter::new();
    let image = SystemOps::screenshot(&adapter, ScreenshotTarget::FullScreen, deadline(10_000))
        .expect("SystemOps::screenshot must be wired");
    assert_png_metadata(&image);
}
