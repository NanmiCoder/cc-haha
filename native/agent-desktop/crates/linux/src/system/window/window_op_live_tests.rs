use std::process::Command;
use std::time::{Duration, Instant};

use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, WindowFilter, WindowInfo, WindowOp,
};

use super::window_op::window_op;
use crate::system::interaction::interaction_lease::acquire;
use crate::system::x11::control::control_error::ControlError;
use crate::system::x11::control::control_send::{WindowWrite, write_window};
use crate::system::x11::control::manager_name;

#[path = "window_owner_live_tests.rs"]
mod owner;
use crate::system::{SharedBus, list_windows};
use crate::tree::live::live_launch::Launched;

#[path = "window_op_live_env_tests.rs"]
mod environment;

const SETTLE: Duration = Duration::from_secs(40);
const TOLERANCE: i32 = 2;

const GTK3: &str = r#"
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
w = Gtk.Window(title="adw")
w.set_default_size(320, 200)
w.add(Gtk.Button(label="b"))
w.connect("destroy", Gtk.main_quit)
w.show_all()
Gtk.main()
"#;

const GTK4: &str = r#"
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, GLib
Gtk.init()
loop = GLib.MainLoop()
w = Gtk.Window(title="adw")
w.set_default_size(320, 200)
w.set_child(Gtk.Button(label="b"))
w.connect("close-request", lambda *a: loop.quit())
w.present()
loop.run()
"#;

const QT: &str = r#"
import sys
from PyQt6.QtWidgets import QApplication, QMainWindow, QPushButton
app = QApplication(sys.argv)
w = QMainWindow()
w.setWindowTitle("adw")
w.setCentralWidget(QPushButton("b"))
w.resize(320, 200)
w.show()
sys.exit(app.exec())
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Geometry {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("a deadline builds")
}

fn script_path(name: &str, source: &str) -> String {
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("a private session");
    let path = format!("{dir}/{name}.py");
    std::fs::write(&path, source).expect("a script writes");
    path
}

pub(in crate::system) fn spawn(launched: &mut Launched, kind: &str) -> u32 {
    let script = script_path(
        &format!("adw-{kind}"),
        match kind {
            "gtk3" => GTK3,
            "gtk4" => GTK4,
            _ => QT,
        },
    );
    if kind == "qt" {
        let python =
            std::env::var("AGENT_DESKTOP_QT_PYTHON").unwrap_or_else(|_| "python3".to_owned());

        return launched.spawn_with_env(
            &python,
            &[&script],
            &[
                ("QT_ACCESSIBILITY", "1".to_owned()),
                ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1".to_owned()),
                ("QT_QPA_PLATFORM", "xcb".to_owned()),
            ]
            .into_iter()
            .chain(app_display())
            .collect::<Vec<_>>(),
        );
    }
    launched.spawn_with_env("python3", &[&script], &app_display())
}

fn app_display() -> Vec<(&'static str, String)> {
    std::env::var("AGENT_DESKTOP_APP_DISPLAY")
        .map(|display| vec![("DISPLAY", display)])
        .unwrap_or_default()
}

fn windows(bus: &SharedBus) -> Vec<WindowInfo> {
    let everything = WindowFilter {
        focused_only: false,
        app: None,
    };
    list_windows(bus, &everything, deadline(10_000)).unwrap_or_default()
}

pub(in crate::system) fn wait_for(bus: &SharedBus, pid: u32) -> WindowInfo {
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        if let Some(window) = windows(bus).into_iter().find(|w| w.pid == pid) {
            return window;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("pid {pid} never listed a window");
}

pub(in crate::system) fn text(program: &str, args: &[&str]) -> String {
    let output = Command::new(program)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("{program} runs: {error}"));
    String::from_utf8_lossy(&output.stdout).into_owned()
}

pub(in crate::system) fn xid_of(pid: u32) -> String {
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        let listed = text("xprop", &["-root", "_NET_CLIENT_LIST"]);
        for id in listed.split('#').nth(1).unwrap_or("").split(',') {
            let id = id.trim();
            let owner = text("xprop", &["-id", id, "_NET_WM_PID"]);
            if owner.split('=').nth(1).map(str::trim) == Some(&pid.to_string()) {
                return id.to_owned();
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("pid {pid} never had an X11 client");
}

fn number(info: &str, label: &str) -> i32 {
    info.lines()
        .find_map(|line| line.trim().strip_prefix(label))
        .and_then(|rest| rest.trim().parse().ok())
        .unwrap_or_else(|| panic!("xwininfo has no {label}"))
}

fn geometry(xid: &str) -> Geometry {
    let info = text("xwininfo", &["-id", xid]);
    Geometry {
        x: number(&info, "Absolute upper-left X:"),
        y: number(&info, "Absolute upper-left Y:"),
        width: number(&info, "Width:"),
        height: number(&info, "Height:"),
    }
}

fn state(xid: &str) -> String {
    text("xprop", &["-id", xid, "_NET_WM_STATE"])
}

pub(in crate::system) fn maximized(xid: &str) -> (bool, bool) {
    let state = state(xid);
    (
        state.contains("_NET_WM_STATE_MAXIMIZED_VERT"),
        state.contains("_NET_WM_STATE_MAXIMIZED_HORZ"),
    )
}

fn hidden(xid: &str) -> bool {
    state(xid).contains("_NET_WM_STATE_HIDDEN")
}

fn frame_extents(xid: &str) -> String {
    text(
        "xprop",
        &["-id", xid, "_NET_FRAME_EXTENTS", "_GTK_FRAME_EXTENTS"],
    )
    .replace('\n', " ")
}

pub(in crate::system) fn apply(window: &WindowInfo, op: WindowOp) -> Result<(), AdapterError> {
    let lease = acquire(deadline(10_000)).expect("a lease");
    window_op(&SharedBus::default(), window, op, &lease).map(|_| ())
}

fn near(left: i32, right: i32) -> bool {
    (left - right).abs() <= TOLERANCE
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(3) {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("{what}");
}

fn exercise(kind: &str, manager: &str) {
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let pid = spawn(&mut launched, kind);
    let window = wait_for(&bus, pid);
    let xid = xid_of(pid);
    std::thread::sleep(Duration::from_millis(1_500));
    println!(
        "window_op_live {manager} {kind}: start {:?} extents {}",
        geometry(&xid),
        frame_extents(&xid)
    );

    apply(
        &window,
        WindowOp::Resize {
            width: 500.0,
            height: 380.0,
        },
    )
    .expect("a resize reads back");
    let sized = geometry(&xid);
    println!("window_op_live {manager} {kind}: resized {sized:?}");
    assert!(near(sized.width, 500) && near(sized.height, 380));

    apply(&window, WindowOp::Move { x: 120.0, y: 90.0 }).expect("a move reads back");
    let moved = geometry(&xid);
    println!("window_op_live {manager} {kind}: moved {moved:?}");
    assert!(near(moved.x, 120) && near(moved.y, 90));

    let before_maximize = geometry(&xid);
    apply(&window, WindowOp::Maximize).expect("a maximize reads back");
    assert_eq!(maximized(&xid), (true, true));
    println!(
        "window_op_live {manager} {kind}: maximized {:?}",
        geometry(&xid)
    );
    apply(&window, WindowOp::Restore)
        .unwrap_or_else(|error| panic!("a restore from maximized reads back: {error:?}"));
    assert_eq!(maximized(&xid), (false, false));
    let restored = geometry(&xid);
    println!("window_op_live {manager} {kind}: restored {restored:?}");
    assert_eq!(
        restored, before_maximize,
        "a restore gives back the client rectangle"
    );
}

fn close_overview() {
    let status = Command::new("xdotool")
        .args(["key", "Escape"])
        .status()
        .expect("xdotool runs");
    assert!(status.success());
    std::thread::sleep(Duration::from_millis(2_500));
}

fn manager() -> String {
    let name = manager_name(deadline(5_000)).unwrap_or_else(|| "unknown".to_owned());
    if name == "GNOME Shell" {
        close_overview();
    }
    name
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/linux-live-gate.sh"]
fn window_op_live_gtk3() {
    exercise("gtk3", &manager());
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/linux-live-gate.sh"]
fn window_op_live_gtk4() {
    exercise("gtk4", &manager());
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/linux-live-gate.sh"]
fn window_op_live_qt() {
    exercise("qt", &manager());
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/linux-live-gate.sh"]
fn window_op_live_a_destroyed_window_is_bad_window_and_not_success() {
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let pid = spawn(&mut launched, "gtk3");
    let window = wait_for(&bus, pid);
    let xid = xid_of(pid);
    let id = u32::from_str_radix(xid.trim_start_matches("0x"), 16).expect("a window id");
    launched.stop();
    wait_until("the window is gone", || {
        !text("xprop", &["-root", "_NET_CLIENT_LIST"]).contains(&xid)
    });
    let sent = write_window(
        id,
        &WindowWrite::Iconify,
        &agent_desktop_core::ProcessIdentity::new(
            pid,
            window.process_instance.clone().expect("instance"),
        ),
        deadline(5_000),
    );
    assert_eq!(sent, Err(ControlError::BadWindow));
    let sent = write_window(
        0x07ff_fff0,
        &WindowWrite::SetMaximized(true),
        &agent_desktop_core::ProcessIdentity::new(
            pid,
            window.process_instance.clone().expect("instance"),
        ),
        deadline(5_000),
    );
    assert_eq!(sent, Err(ControlError::BadWindow));
    let refused =
        apply(&window, WindowOp::Minimize).expect_err("a destroyed window is not success");
    assert!(matches!(
        refused.code,
        ErrorCode::StaleRef | ErrorCode::WindowNotFound
    ));
    assert_eq!(refused.disposition, DeliverySemantics::not_delivered());
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/linux-live-gate.sh"]
fn window_op_live_a_restore_of_a_minimized_window_works_every_time() {
    let manager = manager();
    for kind in ["gtk3", "gtk4", "qt"] {
        let bus = SharedBus::default();
        let mut launched = Launched::new();
        let pid = spawn(&mut launched, kind);
        let window = wait_for(&bus, pid);
        let xid = xid_of(pid);
        std::thread::sleep(Duration::from_millis(1_500));
        let mut milliseconds = Vec::new();
        for _ in 0..18 {
            apply(&window, WindowOp::Minimize).expect("a minimize reads back");
            wait_until("the window is hidden", || hidden(&xid));
            let started = Instant::now();
            let lifted = apply(&window, WindowOp::Restore);
            milliseconds.push(started.elapsed().as_millis());
            assert!(
                lifted.is_ok(),
                "{kind}: a restore works every time: {lifted:?}"
            );
            assert!(!hidden(&xid), "Ok means the hidden flag cleared");
        }
        println!("window_op_live {manager} {kind}: 18 of 18 restores, ms {milliseconds:?}");
    }
}
