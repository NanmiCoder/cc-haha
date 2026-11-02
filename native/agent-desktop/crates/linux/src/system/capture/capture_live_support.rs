use std::process::Command;
use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline, DisplayInfo, WindowFilter, WindowInfo};

use super::window_context::WindowLookup;
use super::window_xid::{XidOutcome, window_xid};

use crate::system::x11::capture::grab::{DisplayGrabber, Grabber};
use crate::system::{SharedBus, list_windows};
use crate::tree::live::live_launch::Launched;

const SETTLE: Duration = Duration::from_secs(40);

const SCREEN_WIDTH: f64 = 1280.0;
const SCREEN_HEIGHT: f64 = 800.0;

const PAINTER: &str = r##"
import sys, gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib
title, color, x, y, w, h = sys.argv[1:7]
win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
win.set_title(title)
win.set_default_size(int(w), int(h))
css = Gtk.CssProvider()
css.load_from_data(("window, window.background { background-color: %s; background-image: none; }" % color).encode())
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_USER)
win.move(int(x), int(y))
win.connect("destroy", Gtk.main_quit)
win.show_all()
GLib.timeout_add(500, lambda: (win.move(int(x), int(y)), False)[1])
Gtk.main()
"##;

pub(super) fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("a deadline builds")
}

pub(super) fn assert_private_display() -> crate::system::x11::live_display::Exclusive {
    let guard = crate::system::x11::live_display::exclusive();
    let display = std::env::var("DISPLAY").expect("a private display");
    assert!(
        !matches!(display.as_str(), ":0" | ":99" | ""),
        "the live display {display} must never be captured"
    );
    assert!(
        std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some(),
        "run through scripts/private-session.sh"
    );
    guard
}

pub(super) fn compositing() -> bool {
    DisplayGrabber
        .compositing(deadline(10_000))
        .expect("the compositing probe answers")
}

pub(super) struct Geometry {
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) width: i32,
    pub(super) height: i32,
}

pub(super) fn paint(launched: &mut Launched, title: &str, color: &str, at: &Geometry) -> u32 {
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("a private session");
    let script = format!("{dir}/capture-painter.py");
    std::fs::write(&script, PAINTER).expect("the painter script writes");
    let args = [
        script.as_str(),
        title,
        color,
        &at.x.to_string(),
        &at.y.to_string(),
        &at.width.to_string(),
        &at.height.to_string(),
    ];
    launched.spawn("python3", &args)
}

pub(super) fn stop(pid: u32) {
    let status = Command::new("kill")
        .args(["-STOP", &pid.to_string()])
        .status()
        .expect("kill runs");
    assert!(status.success(), "pid {pid} could not be stopped");
    let started = Instant::now();
    loop {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status"))
            .expect("the owned painter still exists");
        let state = status
            .lines()
            .find(|line| line.starts_with("State:"))
            .and_then(|line| line.split_whitespace().nth(1));
        if matches!(state, Some("T" | "t")) {
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "pid {pid} never stopped"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub(super) fn wait_for_listed(bus: &SharedBus, pid: u32) -> WindowInfo {
    let everything = WindowFilter {
        focused_only: false,
        app: None,
    };
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        let listed = list_windows(bus, &everything, deadline(10_000)).unwrap_or_default();
        if listed.iter().any(|window| window.pid == pid) {
            std::thread::sleep(Duration::from_millis(1_200));
            let settled = list_windows(bus, &everything, deadline(10_000)).unwrap_or_default();
            if let Some(window) = settled.into_iter().find(|window| window.pid == pid) {
                return window;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("pid {pid} never listed a window");
}

pub(super) fn place_partly_off_screen(
    bus: &SharedBus,
    window: &WindowInfo,
    at: &Geometry,
) -> WindowInfo {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConfigureWindowAux, ConnectionExt};

    let XidOutcome::One(xid) = window_xid(bus, window, deadline(10_000)) else {
        panic!("the window must map to exactly one X11 client to be placed");
    };
    let (connection, _) = x11rb::connect(None).expect("an independent X11 client");
    let placement = ConfigureWindowAux::new().x(at.x).y(at.y);
    let everything = WindowFilter {
        focused_only: false,
        app: None,
    };
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        connection
            .configure_window(xid, &placement)
            .expect("the placement request sends");
        connection.flush().expect("the placement request flushes");
        std::thread::sleep(Duration::from_millis(200));
        let listed = list_windows(bus, &everything, deadline(10_000)).unwrap_or_default();
        let placed = listed.into_iter().find(|listed| listed.pid == window.pid);
        if let Some(placed) = placed
            && let Some(bounds) = placed.bounds
            && (bounds.x + bounds.width > SCREEN_WIDTH || bounds.y + bounds.height > SCREEN_HEIGHT)
        {
            return placed;
        }
    }
    panic!("the window manager never let the window extend past the screen");
}

pub(super) fn reason(error: &agent_desktop_core::AdapterError) -> String {
    error
        .details
        .as_ref()
        .and_then(|details| details["reason"].as_str())
        .unwrap_or("none")
        .to_owned()
}

pub(super) struct FixedLookup {
    pub(super) xid: u32,
}

impl WindowLookup for FixedLookup {
    fn resolve(&self, window: &WindowInfo, _: Deadline) -> Result<WindowInfo, AdapterError> {
        Ok(window.clone())
    }

    fn xid(&self, _: &WindowInfo, _: Deadline) -> XidOutcome {
        XidOutcome::One(self.xid)
    }

    fn displays(&self, deadline: Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
        crate::system::list_displays(deadline)
    }
}

pub(super) fn x_window_id(title: &str) -> u32 {
    let output = Command::new("xwininfo")
        .args(["-name", title])
        .output()
        .expect("xwininfo runs");
    let text = String::from_utf8_lossy(&output.stdout);
    let id = text
        .split("Window id: ")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .expect("xwininfo names the window");
    u32::from_str_radix(id.trim_start_matches("0x"), 16).expect("a window id")
}
