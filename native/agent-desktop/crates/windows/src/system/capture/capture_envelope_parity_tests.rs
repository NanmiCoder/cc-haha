//! Clipboard envelope parity drives `clipboard_set` and `clipboard_clear`
//! through the real adapter, and both commands take the real cross-process
//! interaction lease, so the body holds
//! `test_support::with_interaction_lease_test_lock` for its whole run - the
//! same serialization the interaction-lease suite mandates for anything that
//! reaches the real lease. It takes no other cross-module test lock, so the
//! crate-wide lock order (fixture, shell, lease) is preserved trivially.
use crate::adapter::WindowsAdapter;
use crate::input::clipboard::{clear, set_content};
use crate::system::private_file::WindowsPrivateFile;
use crate::tree::fixture::{LocalPatternFixture, bootstrap};
use agent_desktop_core::commands::clipboard_clear;
use agent_desktop_core::commands::clipboard_get::{self, ClipboardGetArgs};
use agent_desktop_core::commands::clipboard_set::{self, ClipboardSetArgs};
use agent_desktop_core::commands::screenshot::{self, ScreenshotArgs};
use agent_desktop_core::{
    AppError, ClipboardContent, ClipboardFormat, CommandContext, DeliverySemantics, ErrorCode,
    ErrorPayload, ImageBuffer, ImageFormat, PrivateFileOps, ProcessId, ScreenshotTarget, SystemOps,
    WindowInfo, WindowState, parse_png_dimensions,
};
use serde_json::Value;
use std::path::PathBuf;

const LIVE_STAGE_VARIABLE: &str = "AGENT_DESKTOP_LIVE_WPF";

use crate::system::capture::capture_test_support::{
    HomeIsolation, install_windows_private_file, live_graphics_capture_lock, sample_png,
    with_restored_clipboard,
};
use crate::system::fixture::test_time::deadline;

fn keys_of(value: &Value) -> Vec<&str> {
    value
        .as_object()
        .expect("data must be an object")
        .keys()
        .map(String::as_str)
        .collect()
}

fn error_wire(error: &agent_desktop_core::AdapterError) -> Value {
    serde_json::to_value(ErrorPayload::from_app_error(&AppError::from(error.clone())))
        .expect("ErrorPayload serializes")
}

fn assert_disposition_wire(error: &agent_desktop_core::AdapterError, expected: DeliverySemantics) {
    let wire = error_wire(error);
    let projected = serde_json::to_value(expected).expect("disposition serializes");
    assert_eq!(wire["disposition"], projected, "disposition wire shape");
}

#[test]
fn screenshot_failure_disposition_serializes_not_delivered() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let adapter = WindowsAdapter::new();
    let fixture = LocalPatternFixture::create().expect("pattern fixture");
    let info = WindowInfo {
        id: format!("w-{}", fixture.handle() as usize),
        title: String::new(),
        app: String::new(),
        pid: ProcessId::from(std::process::id()),
        process_instance: None,
        bounds: None,
        state: WindowState::default(),
    };
    let error = SystemOps::screenshot(
        &adapter,
        ScreenshotTarget::ExactWindow(info),
        deadline(10_000),
    )
    .expect_err("ExactWindow without process_instance must fail before capture");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_disposition_wire(&error, DeliverySemantics::not_delivered());
}

#[test]
fn screenshot_path_and_inline_data_shapes_match_core_serialization() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    install_windows_private_file();
    let adapter = WindowsAdapter::new();
    let dir = std::env::temp_dir().join(format!(
        "agent-desktop-screenshot-envelope-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("scratch");
    let path = dir.join("shot.png");

    let with_path = screenshot::execute(
        ScreenshotArgs {
            app: None,
            window_id: None,
            screen: None,
            output_path: Some(path.clone()),
        },
        &adapter,
    )
    .expect("screenshot path");
    assert_eq!(
        keys_of(&with_path),
        ["format", "height", "path", "scale_factor", "width"]
    );
    assert_eq!(with_path["path"], path.to_string_lossy().as_ref());
    assert_eq!(with_path["format"], "png");
    assert!(with_path["width"].as_u64().unwrap() > 0);
    assert!(with_path["height"].as_u64().unwrap() > 0);
    assert!(with_path["scale_factor"].as_f64().unwrap() > 0.0);
    assert!(path.is_file(), "user-named PATH must land bytes");

    let inline = screenshot::execute(
        ScreenshotArgs {
            app: None,
            window_id: None,
            screen: None,
            output_path: None,
        },
        &adapter,
    )
    .expect("screenshot inline");
    assert_eq!(
        keys_of(&inline),
        ["data", "format", "height", "scale_factor", "width"]
    );
    assert!(inline["data"].as_str().unwrap().len() > 8);
    assert_eq!(inline["format"], "png");

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(!path.exists(), "screenshot scratch must be removed");
}

#[test]
fn clipboard_get_set_clear_data_shapes_match_core_serialization() {
    crate::system::fixture::test_support::with_interaction_lease_test_lock(|| {
        with_restored_clipboard(|| {
            install_windows_private_file();
            let adapter = WindowsAdapter::new();
            let _home = HomeIsolation::enter("agent-desktop-capture-home");

            clear(deadline(10_000)).expect("clear before found:false");
            let missing = clipboard_get::execute(
                ClipboardGetArgs {
                    format: Some(ClipboardFormat::Image),
                    out: None,
                },
                &adapter,
                &CommandContext::default(),
            )
            .expect("empty clipboard is structured absence");
            assert_eq!(keys_of(&missing), ["found", "type"]);
            assert_eq!(missing["type"], "image");
            assert_eq!(missing["found"], false);

            let set = clipboard_set::execute(
                ClipboardSetArgs {
                    text: Some("envelope-parity-marker".into()),
                    image: None,
                    file_urls: vec![],
                },
                &adapter,
            )
            .expect("clipboard-set");
            assert_eq!(
                keys_of(&set),
                ["action", "disposition", "steps", "target", "type"]
            );
            assert_eq!(set["disposition"]["delivery"], "delivered_unverified");
            assert_eq!(set["type"], "text");

            let got = clipboard_get::execute(
                ClipboardGetArgs {
                    format: Some(ClipboardFormat::Text),
                    out: None,
                },
                &adapter,
                &CommandContext::default(),
            )
            .expect("clipboard-get text");
            assert_eq!(keys_of(&got), ["text", "type"]);
            assert_eq!(got["type"], "text");
            assert_eq!(got["text"], "envelope-parity-marker");

            let png = sample_png();
            let (width, height) = parse_png_dimensions(&png).expect("dims");
            set_content(
                &ClipboardContent::Image(ImageBuffer {
                    data: png,
                    format: ImageFormat::Png,
                    width,
                    height,
                    scale_factor: 1.0,
                }),
                deadline(10_000),
            )
            .expect("seed image");
            let image = clipboard_get::execute(
                ClipboardGetArgs {
                    format: Some(ClipboardFormat::Image),
                    out: None,
                },
                &adapter,
                &CommandContext::default(),
            )
            .expect("clipboard-get image");
            assert_eq!(keys_of(&image), ["height", "path", "type", "width"]);
            assert_eq!(image["type"], "image");
            assert_eq!(image["width"], width);
            assert_eq!(image["height"], height);
            let written = PathBuf::from(image["path"].as_str().expect("path string"));
            assert!(written.is_file());
            let bytes = WindowsPrivateFile::new()
                .read_private_bounded(&written, 1024 * 1024)
                .expect("TokenOwner-owned private image must be readable");
            assert!(!bytes.is_empty());
            let _ = std::fs::remove_file(&written);

            let cleared = clipboard_clear::execute(&adapter).expect("clipboard-clear");
            assert_eq!(
                keys_of(&cleared),
                ["action", "disposition", "steps", "target"]
            );
            assert_eq!(cleared["disposition"]["delivery"], "delivered_unverified");
        });
    });
}

#[test]
fn non_one_scale_factor_capture_skipped_on_96dpi_only_hosts() {
    let _capture = live_graphics_capture_lock();
    bootstrap();
    let displays = crate::system::display::list_displays_live(deadline(10_000)).expect("displays");
    let Some(scaled) = displays
        .iter()
        .find(|display| (display.scale - 1.0).abs() > 0.001)
    else {
        eprintln!(
            "skip: non-1.0 scale_factor capture needs a display above 96 DPI; every measured host so far is 96 DPI only (A10-3/A16-4), and a second display is not manufacturable here"
        );
        return;
    };
    let image = crate::system::capture::screenshot::screenshot(
        agent_desktop_core::ScreenshotTarget::Display {
            index: displays
                .iter()
                .position(|display| display.id == scaled.id)
                .expect("scaled display index"),
            expected: scaled.clone(),
        },
        deadline(10_000),
    )
    .expect("scaled display capture");
    assert!(
        (image.scale_factor - scaled.scale).abs() < 0.001,
        "capture must report the owning display scale {}, got {}",
        scaled.scale,
        image.scale_factor
    );
}

#[test]
fn the_windows_lane_opts_into_live_capture_staging() {
    let workflow = include_str!("../../../../../.github/workflows/ci.yml").replace("\r\n", "\n");
    let assignment = format!("{LIVE_STAGE_VARIABLE}: \"1\"");
    let step = workflow
        .split("- name: ")
        .find(|step| step.starts_with("Core and Windows unit tests"))
        .expect("the Windows lane runs a library-test step");
    assert!(
        step.contains(&assignment),
        "the library-test step must opt into on-screen staging for live capture breadth"
    );
}
