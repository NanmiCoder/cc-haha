use std::ffi::OsStr;
use std::fs::File;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use super::live_process::stderr_path;

pub(crate) struct Launched {
    children: Vec<Child>,
    pub(crate) scratch: Vec<PathBuf>,
}

impl Launched {
    /// A launcher for apps in a private session. Apps that D-Bus activates
    /// take their display from the bus's activation environment, not from this
    /// process, so a launcher outside the session helper could map windows on
    /// the owner's screen; it refuses to start there.
    pub(crate) fn new() -> Self {
        assert!(
            std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some(),
            "live launches must run inside scripts/private-session.sh"
        );
        Self::bare()
    }

    /// A launcher without the private-session guard, for the harness's own
    /// tests, which start plain shell commands and map no window.
    pub(crate) fn bare() -> Self {
        Self {
            children: Vec::new(),
            scratch: Vec::new(),
        }
    }

    /// Starts a program and returns its pid; a program that cannot start
    /// panics. A leg of an aggregate test starts its program with `try_spawn`,
    /// so a missing program is one entry in the report and hides no other leg.
    pub(crate) fn spawn(&mut self, program: &str, args: &[&str]) -> u32 {
        self.spawn_with_env(program, args, &[])
    }

    pub(crate) fn spawn_with_env(
        &mut self,
        program: &str,
        args: &[&str],
        env: &[(&str, String)],
    ) -> u32 {
        self.try_spawn_with_env(program, args, env)
            .unwrap_or_else(|error| panic!("{error}"))
    }

    pub(crate) fn try_spawn(&mut self, program: &str, args: &[&str]) -> Result<u32, String> {
        self.try_spawn_with_env(program, args, &[])
    }

    pub(crate) fn try_spawn_with_env(
        &mut self,
        program: &str,
        args: &[&str],
        env: &[(&str, String)],
    ) -> Result<u32, String> {
        use std::os::unix::process::CommandExt;
        let staging = std::env::temp_dir().join(format!("{}.stderr", nonce("launch")));
        let stderr = File::create(&staging).map_or_else(|_| Stdio::null(), Stdio::from);
        let child = Command::new(program)
            .args(args)
            .envs(env.iter().map(|(key, value)| (*key, value)))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
            .process_group(0)
            .spawn()
            .map_err(|error| {
                let _ = std::fs::remove_file(&staging);
                format!("could not launch {program}: {error}")
            })?;
        let pid = child.id();
        let _ = std::fs::rename(&staging, stderr_path(pid));
        self.children.push(child);
        Ok(pid)
    }

    pub(crate) fn stop(&mut self) {
        for child in &mut self.children {
            let group = format!("-{}", child.id());
            let _ = Command::new("kill").args(["-KILL", "--", &group]).status();
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(stderr_path(child.id()));
        }
        self.children.clear();
        stop_activated_servers();
        for path in self.scratch.drain(..) {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

/// Ends the servers that D-Bus started for a launched client and that outlive
/// it: `gnome-terminal` only asks its server to open a window, so killing the
/// client leaves the server and its window for every later test of the
/// session. Only processes of this session's own runtime directory are
/// signalled, each by pid, and only inside a private session: anywhere else the
/// runtime directory is the owner's live desktop.
fn stop_activated_servers() {
    let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") else {
        return;
    };
    let session = std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION");
    if !is_private_runtime(&runtime, session.as_deref()) {
        return;
    }
    let wanted = format!("XDG_RUNTIME_DIR={}", runtime.to_string_lossy());
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let comm = std::fs::read_to_string(entry.path().join("comm")).unwrap_or_default();
        if !is_activated_server(comm.trim()) {
            continue;
        }
        let environ = std::fs::read(entry.path().join("environ")).unwrap_or_default();
        let ours = environ
            .split(|byte| *byte == 0)
            .any(|variable| variable == wanted.as_bytes());
        if ours {
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
    }
}

fn is_activated_server(comm: &str) -> bool {
    comm.starts_with("gnome-terminal-")
}

fn is_private_runtime(runtime: &OsStr, session: Option<&OsStr>) -> bool {
    session == Some(runtime)
}

impl Drop for Launched {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The command line the live tests give VS Code. `--password-store=basic` is
/// required in a private session: its keyring starts empty, so the first
/// secrets request makes the keyring daemon open a password prompt nobody
/// answers, and the browser's UI thread, which also serves the accessibility
/// bus, blocks on that request and its frame leaves the registry (`L19-4`).
pub(crate) fn vscode_arguments(user_data_dir: &str) -> [&str; 6] {
    [
        "--no-sandbox",
        "--password-store=basic",
        "--user-data-dir",
        user_data_dir,
        "--disable-extensions",
        "--new-window",
    ]
}

pub(crate) fn nonce(label: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("ad-live-{label}-{}-{nanos}", std::process::id())
}

/// Runs one leg of an aggregate test. A panic inside the leg becomes its
/// error, so the legs after it still run and the report lists every outcome.
pub(crate) fn run_leg(leg: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(leg)).unwrap_or_else(|payload| {
        let message = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied())
            .unwrap_or("no panic message");
        Err(format!("panicked: {message}"))
    })
}

pub(crate) fn program_of(pid: u32) -> Option<String> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let argv0 = String::from_utf8_lossy(bytes.split(|byte| *byte == 0).next()?).into_owned();
    argv0.rsplit('/').next().map(str::to_owned)
}

/// Box facts that decide whether a tree that never filled is the application's fault
/// or the machine's: load average and memory and swap headroom.
pub(crate) fn environment_note() -> String {
    let load = std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|text| {
            text.split_whitespace()
                .take(3)
                .collect::<Vec<_>>()
                .join(" ")
                .into()
        })
        .unwrap_or_else(|| "unreadable".to_owned());
    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let kib = |key: &str| {
        meminfo
            .lines()
            .find_map(|line| line.strip_prefix(key))
            .and_then(|rest| rest.trim_start_matches(':').split_whitespace().next())
            .map_or_else(
                || "?".to_owned(),
                |value| format!("{} MiB", value.parse::<u64>().map_or(0, |kib| kib / 1024)),
            )
    };
    format!(
        "box load {load}, MemAvailable {}, SwapFree {}",
        kib("MemAvailable"),
        kib("SwapFree")
    )
}

#[cfg(test)]
mod activated_tests {
    use std::ffi::OsStr;

    use super::{is_activated_server, is_private_runtime};

    #[test]
    fn only_the_terminal_server_is_an_activated_server() {
        assert!(is_activated_server("gnome-terminal-"));
        assert!(!is_activated_server("gnome-terminal"));
        assert!(!is_activated_server("dbus-daemon"));
        assert!(!is_activated_server("Xvfb"));
        assert!(!is_activated_server("openbox"));
    }

    #[test]
    fn the_sweep_runs_only_in_the_private_sessions_own_runtime_directory() {
        let live = OsStr::new("/run/user/1000");
        let private = OsStr::new("/tmp/agent-desktop-sessions-1000/rt.AbC123");
        assert!(!is_private_runtime(live, None));
        assert!(!is_private_runtime(live, Some(private)));
        assert!(is_private_runtime(private, Some(private)));
    }
}

#[cfg(test)]
mod spawn_tests {
    use std::time::{Duration, Instant};

    use super::{Launched, run_leg};
    use crate::tree::live::live_process::{is_running, process_report, stderr_path};

    fn wait_for_exit(pid: u32) {
        let started = Instant::now();
        while is_running(pid) {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "process {pid} did not exit"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_missing_program_is_an_error_not_a_panic() {
        let mut launched = Launched::bare();
        let error = launched
            .try_spawn("ad-live-no-such-program", &[])
            .expect_err("a missing program cannot start");
        assert!(
            error.contains("could not launch ad-live-no-such-program"),
            "{error}"
        );
    }

    #[test]
    fn a_panicking_leg_is_its_error_and_the_next_leg_still_runs() {
        let literal = run_leg(|| panic!("the fixture is missing"));
        let formatted = run_leg(|| panic!("{} is missing", "the fixture"));
        let next = run_leg(|| Ok(()));
        assert_eq!(literal, Err("panicked: the fixture is missing".to_owned()));
        assert_eq!(
            formatted,
            Err("panicked: the fixture is missing".to_owned())
        );
        assert_eq!(next, Ok(()));
    }

    #[test]
    fn an_exited_child_is_not_running_and_reports_its_status_and_stderr() {
        let mut launched = Launched::bare();
        let pid = launched
            .try_spawn(
                "sh",
                &[
                    "-c",
                    "echo ModuleNotFoundError: no module named PyQt6 >&2; exit 3",
                ],
            )
            .expect("sh starts");
        wait_for_exit(pid);
        assert!(!is_running(pid));
        let report = process_report(pid);
        assert!(report.contains("exit status: 3"), "{report}");
        assert!(
            report.contains("ModuleNotFoundError: no module named PyQt6"),
            "{report}"
        );
        launched.stop();
        assert!(!stderr_path(pid).exists());
        assert!(process_report(pid).contains("is gone; no stderr was captured"));
    }

    #[test]
    fn a_running_child_is_running_until_stop_ends_it() {
        let mut launched = Launched::bare();
        let pid = launched.try_spawn("sleep", &["30"]).expect("sleep starts");
        assert!(is_running(pid));
        assert!(process_report(pid).contains("is running; its stderr is empty"));
        launched.stop();
        assert!(!is_running(pid));
    }
}
