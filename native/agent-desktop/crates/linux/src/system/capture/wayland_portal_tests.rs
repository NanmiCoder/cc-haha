use std::cell::{Cell, RefCell};
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;

use agent_desktop_core::{DisplayInfo, Rect};

use super::*;
use crate::system::capture::wayland_portal_call::{Pending, PortalAnswer, request_path};

struct Answer(Result<PortalAnswer, AdapterError>);

impl Pending for Answer {
    fn cancel(self: Box<Self>) {}

    fn wait(self: Box<Self>, _deadline: Deadline) -> Result<PortalAnswer, AdapterError> {
        self.0
    }
}

struct Wire {
    answer: Result<PortalAnswer, AdapterError>,
    calls: Rc<RefCell<Vec<String>>>,
}

impl PortalWire for Wire {
    fn unique_name(&self) -> String {
        ":1.9".into()
    }

    fn subscribe(&self, path: &str, _deadline: Deadline) -> Result<Box<dyn Pending>, AdapterError> {
        self.calls.borrow_mut().push(format!("subscribe {path}"));
        Ok(Box::new(Answer(self.answer.clone())))
    }

    fn call_screenshot(&self, token: &str, _deadline: Deadline) -> Result<String, AdapterError> {
        self.calls.borrow_mut().push("call".into());
        Ok(request_path(":1.9", token))
    }
}

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("a deadline")
}

fn scratch(name: &str) -> PathBuf {
    use std::os::unix::fs::DirBuilderExt;

    let name = agent_desktop_core::temporary_file_name(std::ffi::OsStr::new(name));
    let dir = std::env::temp_dir().join(name);
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .expect("exclusive private temporary directory");
    dir
}

fn tiny_png(width: u32, height: u32) -> Vec<u8> {
    let mut data = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    data.extend_from_slice(b"IHDR");
    data.extend_from_slice(&width.to_be_bytes());
    data.extend_from_slice(&height.to_be_bytes());
    data.extend_from_slice(&[8, 2, 0, 0, 0]);
    data.extend_from_slice(&[0; 4]);
    data
}

fn display(id: &str, x: f64, width: f64, height: f64) -> DisplayInfo {
    DisplayInfo {
        id: id.into(),
        bounds: Rect {
            x,
            y: 0.0,
            width,
            height,
        },
        scale: 1.0,
        is_primary: x == 0.0,
    }
}

fn two_displays() -> Vec<DisplayInfo> {
    vec![
        display("a", 0.0, 40.0, 30.0),
        display("b", 40.0, 20.0, 20.0),
    ]
}

fn gradient_png(width: u32, height: u32) -> Vec<u8> {
    let mut data = Vec::new();
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&[x as u8, y as u8, 7]);
        }
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().expect("a header");
    writer.write_image_data(&data).expect("pixels");
    writer.finish().expect("done");
    out
}

fn run(
    target: &ScreenshotTarget,
    answer: Result<PortalAnswer, AdapterError>,
    roots: &[PathBuf],
) -> (Result<ImageBuffer, AdapterError>, Vec<String>) {
    run_on(target, answer, roots, two_displays())
}

fn run_on(
    target: &ScreenshotTarget,
    answer: Result<PortalAnswer, AdapterError>,
    roots: &[PathBuf],
    shown: Vec<DisplayInfo>,
) -> (Result<ImageBuffer, AdapterError>, Vec<String>) {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let connect = {
        let calls = Rc::clone(&calls);
        move |_deadline: Deadline| -> Result<Box<dyn PortalWire>, AdapterError> {
            Ok(Box::new(Wire {
                answer: answer.clone(),
                calls: Rc::clone(&calls),
            }))
        }
    };
    let listing = move |_deadline: Deadline| Ok(shown.clone());
    let outcome = capture_with(target, deadline(), &connect, roots, &listing);
    let seen = calls.borrow().clone();
    (outcome, seen)
}

fn granted(path: &std::path::Path) -> Result<PortalAnswer, AdapterError> {
    Ok(PortalAnswer::Granted {
        uri: Some(format!("file://{}", path.display())),
    })
}

#[test]
fn the_whole_screen_is_the_portals_png_and_its_file_is_removed() {
    let dir = scratch("whole");
    let path = dir.join("Screenshot.png");
    fs::write(&path, tiny_png(1280, 800)).expect("a png");
    let one = vec![display("a", 0.0, 1280.0, 800.0)];
    let (outcome, calls) = run_on(&ScreenshotTarget::FullScreen, granted(&path), &[dir], one);
    let image = outcome.expect("an image");
    assert_eq!((image.width, image.height), (1280, 800));
    assert_eq!(calls.len(), 2);
    assert!(!path.exists());
}

#[test]
fn the_whole_screen_of_two_monitors_is_the_primary_display_only() {
    let dir = scratch("primary");
    let path = dir.join("Screenshot.png");
    fs::write(&path, gradient_png(60, 30)).expect("a png");
    let (outcome, _) = run(&ScreenshotTarget::FullScreen, granted(&path), &[dir]);
    let image = outcome.expect("a crop");
    assert_eq!((image.width, image.height), (40, 30));
    assert!(!path.exists());
}

#[test]
fn a_file_that_is_not_a_png_is_an_action_failure_and_is_still_removed() {
    let dir = scratch("junk");
    let path = dir.join("Screenshot.png");
    fs::write(&path, b"not a png at all, only text").expect("a file");
    let (outcome, _) = run(&ScreenshotTarget::FullScreen, granted(&path), &[dir]);
    assert_eq!(outcome.expect_err("junk").code, ErrorCode::ActionFailed);
    assert!(!path.exists());
}

#[test]
fn a_screen_target_is_the_displays_rectangle_of_the_portals_image() {
    let dir = scratch("screen");
    let path = dir.join("Screenshot.png");
    fs::write(&path, gradient_png(60, 30)).expect("a png");
    let (outcome, calls) = run(&ScreenshotTarget::Screen(1), granted(&path), &[dir]);
    let image = outcome.expect("a crop");
    assert_eq!((image.width, image.height), (20, 20));
    assert_eq!(calls.len(), 2);
    assert!(!path.exists());
}

#[test]
fn a_display_target_that_changed_makes_no_portal_call() {
    let stale = display("b", 40.0, 25.0, 20.0);
    let (outcome, calls) = run(
        &ScreenshotTarget::Display {
            index: 1,
            expected: stale,
        },
        Ok(PortalAnswer::Refused { code: 2 }),
        &[],
    );
    assert_eq!(outcome.expect_err("changed").code, ErrorCode::InvalidArgs);
    assert!(calls.is_empty());
}

#[test]
fn an_unknown_screen_index_makes_no_portal_call() {
    let (outcome, calls) = run(
        &ScreenshotTarget::Screen(7),
        Ok(PortalAnswer::Refused { code: 2 }),
        &[],
    );
    assert_eq!(outcome.expect_err("range").code, ErrorCode::InvalidArgs);
    assert!(calls.is_empty());
}

#[test]
fn an_image_that_does_not_confirm_the_layout_is_unsupported_and_still_removed() {
    let dir = scratch("unproven");
    let path = dir.join("Screenshot.png");
    fs::write(&path, gradient_png(50, 30)).expect("a png");
    let (outcome, _) = run(&ScreenshotTarget::Screen(1), granted(&path), &[dir]);
    let error = outcome.expect_err("unproven");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert!(!path.exists());
}

#[test]
fn a_single_monitor_fullscreen_rechecks_the_layout_after_consent() {
    let dir = scratch("rearranged");
    let path = dir.join("Screenshot.png");
    fs::write(&path, gradient_png(60, 30)).expect("a png");
    let first = vec![display("a", 0.0, 40.0, 30.0)];
    let swapped = two_displays();
    let reads = Cell::new(0);
    let listing = |_deadline: Deadline| {
        reads.set(reads.get() + 1);
        Ok(if reads.get() == 1 {
            first.clone()
        } else {
            swapped.clone()
        })
    };
    let calls = Rc::new(RefCell::new(Vec::new()));
    let connect = |_deadline: Deadline| -> Result<Box<dyn PortalWire>, AdapterError> {
        Ok(Box::new(Wire {
            answer: granted(&path),
            calls: Rc::clone(&calls),
        }))
    };
    let outcome = capture_with(
        &ScreenshotTarget::FullScreen,
        deadline(),
        &connect,
        std::slice::from_ref(&dir),
        &listing,
    );
    let error = outcome.expect_err("rearranged");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(error.message.contains("layout changed"));
    assert!(!path.exists());
}

#[test]
fn a_png_over_the_pixel_cap_is_refused_by_the_header_check_and_still_removed() {
    let dir = scratch("huge");
    let path = dir.join("Screenshot.png");
    fs::write(&path, tiny_png(100_000, 100_000)).expect("a png");
    let (outcome, _) = run(&ScreenshotTarget::FullScreen, granted(&path), &[dir]);
    assert_eq!(outcome.expect_err("huge").code, ErrorCode::ActionFailed);
    assert!(!path.exists());
}

#[test]
fn a_window_target_is_unsupported_and_makes_no_portal_call() {
    let window = crate::system::capture::window::fakes::target();
    let (outcome, calls) = run(
        &ScreenshotTarget::ExactWindow(window),
        Ok(PortalAnswer::Refused { code: 2 }),
        &[],
    );
    assert_eq!(
        outcome.expect_err("unsupported").code,
        ErrorCode::PlatformNotSupported
    );
    assert!(calls.is_empty());
}

#[test]
fn repeated_fixture_names_keep_existing_contents_and_create_private_directories() {
    use std::os::unix::fs::PermissionsExt;

    let first = scratch("exclusive");
    std::fs::create_dir_all(&first).expect("first directory");
    let sentinel = first.join("sentinel");
    std::fs::write(&sentinel, b"unchanged").expect("sentinel");
    let second = scratch("exclusive");
    assert_ne!(first, second);
    assert_eq!(
        std::fs::read(sentinel).expect("preserved sentinel"),
        b"unchanged"
    );
    assert_eq!(
        std::fs::metadata(second)
            .expect("directory")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}
