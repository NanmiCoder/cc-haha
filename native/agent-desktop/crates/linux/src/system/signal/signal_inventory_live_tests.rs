use std::process::Command;
use std::time::{Duration, Instant};

use agent_desktop_core::{Deadline, ErrorCode, WindowFilter, WindowInfo};

use super::run_pass;
use crate::system::registry::read_registry;
use crate::system::registry::registry_frames::RootRead;
use crate::system::registry::registry_frames::read_frames;
use crate::system::signal::signal_live_apps::{poll, x11_windows};
use crate::system::{SharedBus, list_windows, resolve_window_strict};
use crate::tree::live::live_launch::Launched;

const SETTLE: Duration = Duration::from_secs(40);

fn deadline() -> Deadline {
    Deadline::after(10_000).expect("a deadline builds")
}

fn everything() -> WindowFilter {
    WindowFilter {
        focused_only: false,
        app: None,
    }
}

fn window_of(bus: &SharedBus, pid: u32) -> WindowInfo {
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        let listed = list_windows(bus, &everything(), deadline()).unwrap_or_default();
        if let Some(window) = listed.into_iter().find(|w| w.pid.get() == pid) {
            return window;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("pid {pid} never listed a window");
}

fn signal(name: &str, pid: u32) {
    let _ = Command::new("kill").args([name, &pid.to_string()]).status();
}

struct Stopped(u32);

impl Drop for Stopped {
    fn drop(&mut self) {
        signal("-CONT", self.0);
    }
}

#[test]
#[ignore = "runs an owned GTK app; use scripts/private-session.sh --wm"]
fn signal_inventory_live_a_stopped_target_is_skipped_slow_roots_read_timed_out_and_resolution_names_it()
 {
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let runtime = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").unwrap();
    let script = format!("{runtime}/stopped-inventory.py");
    std::fs::write(
        &script,
        "import gi\ngi.require_version('Gtk','3.0')\nfrom gi.repository import Gtk\nw=Gtk.Window()\nw.show_all()\nGtk.main()\n",
    ).unwrap();
    let pid = launched.spawn("python3", &[&script]);
    poll("the owned GTK window before SIGSTOP", || {
        (x11_windows(pid).len() == 1).then_some(())
    });
    let window = window_of(&bus, pid);

    let registry = read_registry(&bus, deadline()).expect("registry");
    let pass = run_pass(&bus, &registry, |_| true, deadline()).expect("pass");
    assert!(
        pass.outcomes
            .iter()
            .any(|o| registry.apps[o.app].root.pid() == pid && o.read == RootRead::Read)
    );
    assert!(pass.windows.iter().any(|w| w.info.pid.get() == pid));
    signal("-STOP", pid);
    let stop = Stopped(pid);
    let registry = read_registry(&bus, deadline()).expect("registry with a stopped app");
    let app = registry
        .apps
        .iter()
        .find(|app| app.root.pid() == pid)
        .expect("a stopped app stays on the registry");
    assert!(!app.answered, "a stopped app does not answer its root");

    let pass = run_pass(&bus, &registry, |_| true, deadline()).expect("pass");
    assert!(
        pass.windows
            .iter()
            .any(|w| w.info.pid.get() == pid && !w.info.state.accessible),
        "the stopped app's window is recovered from the display server"
    );
    assert!(
        pass.outcomes
            .iter()
            .all(|o| registry.apps[o.app].root.pid() != pid)
    );
    let only = run_pass(&bus, &registry, |a| a.root.pid() == pid, deadline()).expect("pass");
    assert!(only.outcomes.is_empty());
    assert!(
        only.windows
            .iter()
            .all(|w| w.info.pid.get() == pid && !w.info.state.accessible),
        "a scoped pass on a stopped app lists its display-server windows"
    );

    let roots = vec![app.root.clone()];
    let frames = read_frames(&bus, &roots, deadline()).expect("frames");
    assert_eq!(frames[0].read, RootRead::TimedOut);
    assert!(frames[0].nodes.is_empty());
    let error = resolve_window_strict(&bus, &window, deadline()).expect_err("stopped");
    assert_eq!(error.code, ErrorCode::AppUnresponsive, "{}", error.message);

    drop(stop);
    let started = Instant::now();
    loop {
        if resolve_window_strict(&bus, &window, deadline()).is_ok() {
            break;
        }
        assert!(
            started.elapsed() < SETTLE,
            "the window did not resolve after SIGCONT"
        );
        std::thread::sleep(Duration::from_millis(200));
    }

    signal("-KILL", pid);
    let started = Instant::now();
    loop {
        match resolve_window_strict(&bus, &window, deadline()) {
            Err(error) if error.code == ErrorCode::WindowNotFound => break,
            _ => {
                assert!(
                    started.elapsed() < SETTLE,
                    "a killed app did not read WINDOW_NOT_FOUND"
                );
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}
