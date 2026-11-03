use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use agent_desktop_core::{AppInfo, Deadline, InteractionLease};

use crate::system::interaction::interaction_lease;
use crate::system::process::liveness::{Liveness, liveness};
use crate::system::process::process_facts;
use crate::system::signal::{Signal, send};
use crate::system::x11::control::{ControlRead, toplevels_of};

const SETTLE: Duration = Duration::from_secs(40);

/// A process started so that it is not a child of the test: a child nobody
/// reaps stays a zombie, which would hide whether the close ended it. Drop
/// ends it by pid and token, through the same signal path under test.
pub(in crate::system) struct Orphan {
    pub(in crate::system) pid: u32,
    pub(in crate::system) token: String,
    scratch: Vec<PathBuf>,
}

impl Orphan {
    pub(in crate::system) fn spawn(program: &str, args: &[&str], env: &[(&str, String)]) -> Self {
        assert!(
            std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some(),
            "live closes must run inside scripts/private-session.sh"
        );
        let output = Command::new("sh")
            .args([
                "-c",
                r#""$@" </dev/null >/dev/null 2>&1 & echo $!"#,
                "sh",
                program,
            ])
            .args(args)
            .envs(env.iter().map(|(key, value)| (*key, value)))
            .stdin(Stdio::null())
            .output()
            .expect("sh runs");
        let pid: u32 = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .expect("the shell printed the pid");
        let started = Instant::now();
        loop {
            if let Some(facts) = process_facts::read(pid) {
                return Self {
                    pid,
                    token: facts.instance,
                    scratch: Vec::new(),
                };
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "{program} did not start"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub(in crate::system) fn keep(&mut self, path: PathBuf) {
        self.scratch.push(path);
    }

    pub(in crate::system) fn app(&self, name: &str) -> AppInfo {
        AppInfo {
            name: name.to_owned(),
            pid: self.pid.into(),
            bundle_id: None,
            process_instance: Some(self.token.clone()),
            presentation: None,
        }
    }

    pub(in crate::system) fn stop(&self) {
        signal_by_name("STOP", self.pid);
    }

    pub(in crate::system) fn resume(&self) {
        signal_by_name("CONT", self.pid);
    }

    pub(in crate::system) fn alive(&self) -> bool {
        liveness(self.pid, &self.token) != Liveness::Gone
    }

    pub(in crate::system) fn wait_for_window(&self) -> usize {
        let started = Instant::now();
        while started.elapsed() < SETTLE {
            let deadline = Deadline::after(3_000).expect("a deadline builds");
            if let ControlRead::Ready(windows) = toplevels_of(self.pid, deadline)
                && !windows.is_empty()
            {
                return windows.len();
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        panic!("pid {} never mapped a top-level window", self.pid);
    }

    pub(in crate::system) fn window_count(&self) -> usize {
        let deadline = Deadline::after(3_000).expect("a deadline builds");
        match toplevels_of(self.pid, deadline) {
            ControlRead::Ready(windows) => windows.len(),
            _ => 0,
        }
    }

    pub(in crate::system) fn wait_for_ignored_signal(&self, signal: u32) {
        let mask = 1_u64 << (signal - 1);
        let started = Instant::now();
        loop {
            let status =
                std::fs::read_to_string(format!("/proc/{}/status", self.pid)).unwrap_or_default();
            let ignored = status
                .lines()
                .find_map(|line| line.strip_prefix("SigIgn:"))
                .and_then(|hex| u64::from_str_radix(hex.trim(), 16).ok())
                .unwrap_or(0);
            if ignored & mask != 0 {
                return;
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "the child never ignored signal {signal}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub(in crate::system) fn wait_gone_from_proc(&self) {
        let started = Instant::now();
        while Path::new(&format!("/proc/{}", self.pid)).exists() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "/proc/{} is still there: the process was not reaped",
                self.pid
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Orphan {
    fn drop(&mut self) {
        signal_by_name("CONT", self.pid);
        let _ = send(self.pid, &self.token, Signal::Kill);
        for path in self.scratch.drain(..) {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

fn signal_by_name(name: &str, pid: u32) {
    let _ = Command::new("kill")
        .args([&format!("-{name}"), &pid.to_string()])
        .stderr(Stdio::null())
        .status();
}

pub(in crate::system) fn lease(timeout_ms: u64) -> InteractionLease {
    let deadline = Deadline::after(timeout_ms).expect("a deadline builds");
    interaction_lease::acquire(deadline).expect("the lease is free")
}

fn xdotool(args: &[&str]) -> bool {
    Command::new("xdotool")
        .args(args)
        .stdin(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

impl Orphan {
    pub(in crate::system) fn first_window(&self) -> u32 {
        let deadline = Deadline::after(3_000).expect("a deadline builds");
        match toplevels_of(self.pid, deadline) {
            ControlRead::Ready(windows) => windows.first().expect("a window").id,
            _ => panic!("no window for pid {}", self.pid),
        }
    }

    pub(in crate::system) fn type_text(&self, text: &str) {
        let id = self.first_window().to_string();
        assert!(
            xdotool(&["windowactivate", "--sync", &id]),
            "the window was activated"
        );
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            xdotool(&["type", "--delay", "40", "--", text]),
            "the text was typed"
        );
    }
}

pub(in crate::system) fn text_editor_dialogs(pid: u32) -> usize {
    let toplevels = match crate::system::x11::control::toplevels_of(
        pid,
        Deadline::after(5_000).expect("a deadline builds"),
    ) {
        crate::system::x11::control::ControlRead::Ready(windows) => windows,
        _ => Vec::new(),
    };
    toplevels
        .iter()
        .filter(|window| {
            window.kind == crate::system::x11::window::window_kind::WindowKind::Dialog
                || window.transient
        })
        .count()
}
