use std::process::Command;
use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline, WindowFilter, WindowInfo};

use super::*;
use crate::system::interaction::interaction_lease::acquire;
use crate::system::list_windows;
use crate::tree::live::live_launch::Launched;

pub(super) const SETTLE: Duration = Duration::from_secs(40);

pub(super) const APP: &str = r#"
import os, gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib
w = Gtk.Window(title="adl")
w.set_default_size(320, 200)
if os.environ.get("ADL_NOFOCUS"):
    w.set_focus_on_map(False)
w.add(Gtk.Label(label="l"))
w.connect("destroy", Gtk.main_quit)
w.show_all()
if os.environ.get("ADL_MODAL"):
    dialog = Gtk.Dialog(title="adl-dialog", transient_for=w, modal=True)
    dialog.set_default_size(200, 80)
    GLib.timeout_add(500, lambda: (dialog.show_all(), False)[1])
Gtk.main()
"#;

pub(in crate::system) fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("a deadline builds")
}

pub(in crate::system) fn tool(name: &str) -> Command {
    Command::new(name)
}

pub(in crate::system) fn xprop(args: &[&str]) -> String {
    let output = Command::new("xprop")
        .args(args)
        .output()
        .expect("xprop runs");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn find_xid(pid: u32) -> Option<String> {
    let clients = xprop(&["-root", "_NET_CLIENT_LIST"]);
    clients
        .split('#')
        .nth(1)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .find(|id| {
            xprop(&["-id", id, "_NET_WM_PID"])
                .split('=')
                .nth(1)
                .and_then(|text| text.trim().parse::<u32>().ok())
                == Some(pid)
        })
        .map(str::to_owned)
}

pub(in crate::system) fn xid_of(pid: u32) -> String {
    let started = Instant::now();
    loop {
        if let Some(id) = find_xid(pid) {
            return id;
        }
        assert!(
            started.elapsed() < Duration::from_secs(40),
            "the display lists the app's window"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn wait_mapped(pid: u32) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        if let Some(xid) = find_xid(pid) {
            let info = Command::new("xwininfo")
                .args(["-id", &xid])
                .output()
                .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
                .unwrap_or_default();
            if info.contains("Map State: IsViewable") {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub(super) fn active_pid() -> Option<u32> {
    let active = xprop(&["-root", "_NET_ACTIVE_WINDOW"]);
    let id = active.split_whitespace().last()?.to_owned();
    xprop(&["-id", &id, "_NET_WM_PID"])
        .split('=')
        .nth(1)?
        .trim()
        .parse()
        .ok()
}

pub(super) fn windows_of(bus: &SharedBus, pid: u32) -> Vec<WindowInfo> {
    let everything = WindowFilter {
        focused_only: false,
        app: None,
    };
    list_windows(bus, &everything, deadline(10_000))
        .unwrap_or_default()
        .into_iter()
        .filter(|window| window.pid == pid)
        .collect()
}

pub(super) fn spawn(launched: &mut Launched, bus: &SharedBus, name: &str) -> WindowInfo {
    spawn_with(launched, bus, name, false)
}

pub(in crate::system) fn spawn_with(
    launched: &mut Launched,
    bus: &SharedBus,
    name: &str,
    never_focused: bool,
) -> WindowInfo {
    spawn_env(launched, bus, name, never_focused, false)
}

pub(super) fn spawn_env(
    launched: &mut Launched,
    bus: &SharedBus,
    name: &str,
    never_focused: bool,
    modal: bool,
) -> WindowInfo {
    let script = format!(
        "{}/adl-{name}.py",
        std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("a private session")
    );
    std::fs::write(&script, APP).expect("a script writes");
    let mut env: Vec<(&str, String)> = Vec::new();
    if never_focused {
        env.push(("ADL_NOFOCUS", "1".to_owned()));
    }
    if modal {
        env.push(("ADL_MODAL", "1".to_owned()));
    }
    let pid = launched.spawn_with_env("python3", &[&script], &env);
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        if let Some(window) = windows_of(bus, pid).into_iter().next() {
            wait_mapped(pid);
            return window;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("{name} never listed a window");
}

pub(in crate::system) fn focus(bus: &SharedBus, window: &WindowInfo) -> Result<(), AdapterError> {
    let lease = acquire(deadline(8_000)).expect("a lease");
    focus_window(bus, window, &lease)
}

pub(super) fn close_overview() {
    let status = tool("xdotool")
        .args(["key", "Escape"])
        .status()
        .expect("xdotool runs");
    assert!(status.success());
    std::thread::sleep(Duration::from_millis(2_500));
}
