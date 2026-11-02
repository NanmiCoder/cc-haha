use std::process::Command;
use std::time::{Duration, Instant};

use agent_desktop_core::system::launch_options::LaunchOptions;
use agent_desktop_core::system::launch_result::LaunchResult;
use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use crate::system::interaction::interaction_lease::acquire;
use crate::system::launch::launch_app;
use crate::system::process::process_facts;
use crate::system::{SharedBus, app_inventory};

const SETTLE: Duration = Duration::from_secs(20);

fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("a deadline builds")
}

fn options(args: &[&str]) -> LaunchOptions {
    LaunchOptions {
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        timeout_ms: 15_000,
        ..LaunchOptions::default()
    }
}

fn launch(id: &str, options: &LaunchOptions) -> Result<LaunchResult, AdapterError> {
    assert!(
        std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some(),
        "live launches must run inside scripts/private-session.sh"
    );
    let lease = acquire(deadline(30_000)).expect("a lease");
    launch_app(&SharedBus::default(), id, options, &lease)
}

struct Owned(Vec<u32>);

impl Owned {
    fn keep(&mut self, pid: u32) -> u32 {
        self.0.push(pid);
        pid
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        for pid in &self.0 {
            kill_quietly(*pid);
        }
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5)
            && self.0.iter().any(|pid| process_facts::read(*pid).is_some())
        {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

fn kill_quietly(pid: u32) {
    let _ = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status();
}

fn xprop(args: &[&str]) -> String {
    let output = Command::new("xprop")
        .args(args)
        .output()
        .expect("xprop runs");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn client_ids() -> Vec<String> {
    xprop(&["-root", "_NET_CLIENT_LIST"])
        .split('#')
        .nth(1)
        .unwrap_or_default()
        .split(',')
        .map(|id| id.trim().to_owned())
        .filter(|id| id.starts_with("0x"))
        .collect()
}

fn x_windows_of(pid: u32) -> Vec<String> {
    client_ids()
        .into_iter()
        .filter(|id| {
            xprop(&["-id", id, "_NET_WM_PID"])
                .rsplit('=')
                .next()
                .and_then(|value| value.trim().parse::<u32>().ok())
                == Some(pid)
        })
        .collect()
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("timed out waiting for {what}");
}

fn registry_has(pid: u32) -> bool {
    app_inventory(&SharedBus::default(), deadline(10_000))
        .is_ok_and(|inventory| inventory.apps.iter().any(|app| app.pid == pid))
}

#[test]
#[ignore = "drives real applications; run through scripts/private-session.sh --wm"]
fn live_an_app_that_exits_after_registering_and_before_a_window_is_not_a_launch() {
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("a private session");
    let script = format!("{dir}/launch-early-exit.py");
    std::fs::write(
        &script,
        "import gi, time\ngi.require_version('Gtk', '3.0')\nfrom gi.repository import Gtk, GLib\nGtk.init()\nend = time.time() + 1.5\nwhile time.time() < end:\n    GLib.MainContext.default().iteration(False)\n    time.sleep(0.05)\n",
    )
    .expect("a script");
    let started = Instant::now();
    let error = launch("python3", &options(&[&script])).expect_err("a dead pid is not a launch");
    assert_eq!(error.code, ErrorCode::ActionFailed, "{error:?}");
    assert!(error.message.contains("exited before"), "{error:?}");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the exit is noticed, not waited out: {:?}",
        started.elapsed()
    );
}

#[path = "launch_resident_live_tests.rs"]
mod resident;

#[cfg(test)]
#[path = "launch_handoff_live_tests.rs"]
mod handoff;

#[path = "launch_identity_live_tests.rs"]
mod identity;

#[path = "launch_direct_live_tests.rs"]
mod direct;
