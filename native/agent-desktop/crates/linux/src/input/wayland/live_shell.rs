use std::collections::BTreeSet;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use agent_desktop_core::Deadline;

use super::key_session::KeySession;
use super::remote_desktop::RemoteDesktop;

const ATTEMPTS: u32 = 8;
const HEALTH_READS: u32 = 5;
const SOCKET_WAIT: Duration = Duration::from_secs(20);

/// A headless gnome-shell in the private session. A start-up hangs about half
/// the time with its socket present and its services unanswering, so a shell
/// is kept only once repeated RemoteDesktop sessions complete in time.
pub(super) struct Shell {
    child: Child,
    pub(super) socket: String,
}

fn runtime_dir() -> PathBuf {
    PathBuf::from(std::env::var("XDG_RUNTIME_DIR").expect("a private runtime dir"))
}

fn sockets() -> BTreeSet<String> {
    std::fs::read_dir(runtime_dir())
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.starts_with("wayland-") && !name.ends_with(".lock"))
                .collect()
        })
        .unwrap_or_default()
}

fn healthy() -> bool {
    for _ in 0..HEALTH_READS {
        let Ok(deadline) = Deadline::after(3_000) else {
            return false;
        };
        let Ok(mut session) = RemoteDesktop::open(deadline) else {
            return false;
        };
        let started = session
            .create(deadline)
            .and_then(|()| session.start(deadline));
        let _ = session.stop(deadline);
        if started.is_err() {
            return false;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    true
}

fn clear_stale_sockets() {
    for name in sockets() {
        let _ = std::fs::remove_file(runtime_dir().join(&name));
        let _ = std::fs::remove_file(runtime_dir().join(format!("{name}.lock")));
    }
}

fn spawn() -> Option<Shell> {
    clear_stale_sockets();
    let before = sockets();
    let log = std::fs::File::create(runtime_dir().join("shell.log")).ok()?;
    let child = Command::new("gnome-shell")
        .args([
            "--headless",
            "--wayland",
            "--no-x11",
            "--virtual-monitor",
            "1280x800",
        ])
        .env_remove("DISPLAY")
        .stdin(Stdio::null())
        .stdout(log.try_clone().ok()?)
        .stderr(log)
        .process_group(0)
        .spawn()
        .ok()?;
    let mut shell = Shell {
        child,
        socket: String::new(),
    };
    let until = Instant::now() + SOCKET_WAIT;
    while Instant::now() < until {
        if let Some(new) = sockets().difference(&before).next() {
            shell.socket = new.clone();
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if shell.socket.is_empty() {
        return None;
    }
    std::thread::sleep(Duration::from_secs(3));
    Some(shell)
}

impl Shell {
    pub(super) fn start() -> Self {
        for _ in 0..ATTEMPTS {
            if let Some(shell) = spawn() {
                if healthy() {
                    return shell;
                }
            }
        }
        panic!("no healthy headless gnome-shell after {ATTEMPTS} starts");
    }
}

impl Drop for Shell {
    fn drop(&mut self) {
        let group = format!("-{}", self.child.id());
        let _ = Command::new("kill").args(["-KILL", "--", &group]).status();
        let _ = self.child.kill();
        let _ = self.child.wait();
        std::thread::sleep(Duration::from_secs(2));
    }
}
