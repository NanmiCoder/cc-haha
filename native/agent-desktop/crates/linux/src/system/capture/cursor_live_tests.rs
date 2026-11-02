use agent_desktop_core::{
    CursorOverlayConfig, CursorOverlayControl, CursorOverlayInstruction, Point, ScreenshotTarget,
};

use super::capture_live_support::*;
use crate::system::{SharedBus, capture::screenshot, overlay::cursor_overlay};
use crate::tree::live::live_launch::Launched;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt, CreateWindowAux, WindowClass};

struct Cursor;

impl Drop for Cursor {
    fn drop(&mut self) {
        cursor_overlay::update(&CursorOverlayControl::disable("capture-cursor".into()))
            .expect("retire owned overlay");
    }
}

fn app_pixels(image: &agent_desktop_core::ImageBuffer, expected: [u8; 3]) {
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session");
    let path = format!("{dir}/cursor-capture.png");
    std::fs::write(&path, &image.data).expect("PNG writes");
    let status = std::process::Command::new("python3")
        .args([
            "-c",
            r#"
import gi, sys
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
image = GdkPixbuf.Pixbuf.new_from_file(sys.argv[1])
expected = bytes(map(int, sys.argv[2].split(',')))
pixels = bytes(image.get_pixels())
for y in range(image.get_height()//2, image.get_height()//2+32):
    for x in range(image.get_width()//2, image.get_width()//2+24):
        offset = y*image.get_rowstride()+x*image.get_n_channels()
        assert pixels[offset:offset+3] == expected
"#,
            &path,
            &format!("{},{},{}", expected[0], expected[1], expected[2]),
        ])
        .status()
        .expect("independent PNG pixel oracle");
    assert!(
        status.success(),
        "capture contains app pixels, not cursor or cover pixels"
    );
}

#[test]
#[ignore = "captures a real app with an owned overlay and a real cover on private X11"]
fn a_cursor_overlay_does_not_cover_or_contaminate_window_capture() {
    let _display = assert_private_display();
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let geometry = Geometry {
        x: 200,
        y: 150,
        width: 320,
        height: 200,
    };
    let pid = paint(&mut launched, "cursor-capture-target", "#ff0000", &geometry);
    let window = wait_for_listed(&bus, pid);
    let bounds = window.bounds.expect("window bounds");
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session");
    let expected = crate::system::x11::capture::xwd_oracle::xwd_pixel(
        x_window_id(&window.title),
        bounds.width as usize / 2,
        bounds.height as usize / 2,
        &dir,
    );
    assert_ne!(
        expected,
        [0, 0, 255],
        "uncovered app differs from the cover"
    );
    cursor_overlay::update(&CursorOverlayControl::enable(
        "capture-cursor".into(),
        Default::default(),
    ))
    .expect("enable cursor");
    let _cursor = Cursor;
    cursor_overlay::update(&CursorOverlayControl::present(
        "capture-cursor".into(),
        CursorOverlayInstruction::new(
            Point {
                x: bounds.x + bounds.width / 2.0,
                y: bounds.y + bounds.height / 2.0,
            },
            &CursorOverlayConfig::enabled(None, 8).expect("cursor config"),
            false,
        )
        .expect("cursor position"),
    ))
    .expect("position cursor over app");
    let image = screenshot::screenshot(
        &bus,
        ScreenshotTarget::ExactWindow(window.clone()),
        deadline(20_000),
    )
    .expect("the tool's overlay must not block capture");
    app_pixels(&image, expected);
    let oracle = std::process::Command::new("xwininfo")
        .args(["-name", "agent-desktop cursor overlay"])
        .output()
        .expect("independent overlay oracle");
    assert!(
        String::from_utf8_lossy(&oracle.stdout).contains("Map State: IsViewable"),
        "capture restores the overlay"
    );
    let (cover, screen) = x11rb::connect(None).expect("independent cover client");
    let id = cover.generate_id().expect("cover id");
    cover
        .create_window(
            0,
            id,
            cover.setup().roots[screen].root,
            (bounds.x + bounds.width / 2.0 - 40.0) as i16,
            (bounds.y + bounds.height / 2.0 - 40.0) as i16,
            100,
            100,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new()
                .override_redirect(1)
                .background_pixel(0x0000ff),
        )
        .expect("create real cover")
        .check()
        .expect("cover created");
    cover
        .map_window(id)
        .expect("map cover")
        .check()
        .expect("cover mapped");
    assert_eq!(
        crate::system::x11::capture::xwd_oracle::xwd_pixel(
            id,
            20,
            20,
            &std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session")
        ),
        [0, 0, 255]
    );
    let covered = screenshot::screenshot(
        &bus,
        ScreenshotTarget::ExactWindow(window),
        deadline(20_000),
    );
    if compositing() {
        app_pixels(
            &covered.expect("a compositor retains the target's own pixels"),
            expected,
        );
    } else {
        let Err(error) = covered else {
            panic!("a real covering window still refuses")
        };
        assert_eq!(reason(&error), "covered");
    }
}
