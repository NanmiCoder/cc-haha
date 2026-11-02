use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::fs::FileExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use agent_desktop_core::{Deadline, MAX_PNG_INPUT_BYTES};
use rustix::fs::{MemfdFlags, memfd_create};

const FIRST_PAUSE: Duration = Duration::from_millis(1);
const LONGEST_PAUSE: Duration = Duration::from_millis(20);
const STDERR_CAP: usize = 4096;
const READ_CHUNK: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunSpec {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<String>,
    pub(crate) stdin: Option<Vec<u8>>,
    pub(crate) capture_stdout: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RunOutcome {
    Exited {
        code: Option<i32>,
        stdout: Vec<u8>,
        stderr: String,
    },
    OverCap,
    TimedOut,
    NotStarted(String),
}

pub(crate) trait CommandRunner {
    fn run(&self, spec: &RunSpec, deadline: Deadline) -> RunOutcome;
}

/// Starts the program itself, never through a shell. Standard error goes to an
/// anonymous file and not a pipe, so a server the program leaves behind never
/// holds the caller's end open.
pub(crate) struct ProcessRunner {
    pub(crate) env: Vec<(String, String)>,
}

struct Capture {
    bytes: Receiver<Vec<u8>>,
    over_cap: Arc<AtomicBool>,
}

fn stderr_file() -> std::io::Result<File> {
    memfd_create("ad-wl-stderr", MemfdFlags::CLOEXEC)
        .map(File::from)
        .map_err(std::io::Error::from)
}

fn spawn(spec: &RunSpec, env: &[(String, String)], stderr: &File) -> std::io::Result<Child> {
    let pipe_if = |wanted: bool| {
        if wanted {
            Stdio::piped()
        } else {
            Stdio::null()
        }
    };
    Command::new(&spec.program)
        .args(&spec.args)
        .envs(env.iter().map(|(name, value)| (name, value)))
        .stdin(pipe_if(spec.stdin.is_some()))
        .stdout(pipe_if(spec.capture_stdout))
        .stderr(Stdio::from(stderr.try_clone()?))
        .spawn()
}

fn feed_stdin(child: &mut Child, payload: Option<&[u8]>) {
    let (Some(mut pipe), Some(bytes)) = (child.stdin.take(), payload.map(<[u8]>::to_vec)) else {
        return;
    };
    std::thread::spawn(move || {
        let _ = pipe.write_all(&bytes);
    });
}

fn capture_stdout(child: &mut Child) -> Option<Capture> {
    let mut pipe = child.stdout.take()?;
    let (sender, bytes) = mpsc::channel();
    let over_cap = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&over_cap);
    std::thread::spawn(move || {
        let mut held = Vec::new();
        let mut chunk = vec![0u8; READ_CHUNK];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => held.extend_from_slice(&chunk[..read]),
            }
            if held.len() > MAX_PNG_INPUT_BYTES {
                flag.store(true, Ordering::SeqCst);
                break;
            }
        }
        let _ = sender.send(held);
    });
    Some(Capture { bytes, over_cap })
}

fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

enum Waited {
    Exited(Option<i32>),
    OverCap,
    TimedOut,
}

fn wait_for_exit(child: &mut Child, capture: Option<&Capture>, deadline: Deadline) -> Waited {
    let mut pause = FIRST_PAUSE;
    loop {
        if capture.is_some_and(|held| held.over_cap.load(Ordering::SeqCst)) {
            return Waited::OverCap;
        }
        match child.try_wait() {
            Ok(Some(status)) => return Waited::Exited(status.code()),
            Ok(None) => {}
            Err(_) => return Waited::TimedOut,
        }
        let Ok(slice) = deadline.remaining_slice(pause) else {
            return Waited::TimedOut;
        };
        std::thread::sleep(slice);
        pause = (pause * 2).min(LONGEST_PAUSE);
    }
}

fn read_stderr(file: &File) -> String {
    let mut bytes = vec![0u8; STDERR_CAP];
    let read = file.read_at(&mut bytes, 0).unwrap_or(0);
    String::from_utf8_lossy(&bytes[..read]).into_owned()
}

fn drained(capture: Option<Capture>, deadline: Deadline) -> Option<Vec<u8>> {
    match capture {
        None => Some(Vec::new()),
        Some(held) => held.bytes.recv_timeout(deadline.remaining()).ok(),
    }
}

impl CommandRunner for ProcessRunner {
    fn run(&self, spec: &RunSpec, deadline: Deadline) -> RunOutcome {
        let stderr = match stderr_file() {
            Ok(file) => file,
            Err(error) => return RunOutcome::NotStarted(error.to_string()),
        };
        let mut child = match spawn(spec, &self.env, &stderr) {
            Ok(child) => child,
            Err(error) => return RunOutcome::NotStarted(error.to_string()),
        };
        feed_stdin(&mut child, spec.stdin.as_deref());
        let capture = capture_stdout(&mut child);
        let code = match wait_for_exit(&mut child, capture.as_ref(), deadline) {
            Waited::Exited(code) => code,
            Waited::OverCap => {
                stop(&mut child);
                return RunOutcome::OverCap;
            }
            Waited::TimedOut => {
                stop(&mut child);
                return RunOutcome::TimedOut;
            }
        };
        let Some(stdout) = drained(capture, deadline) else {
            return RunOutcome::TimedOut;
        };
        if stdout.len() > MAX_PNG_INPUT_BYTES {
            return RunOutcome::OverCap;
        }
        RunOutcome::Exited {
            code,
            stdout,
            stderr: read_stderr(&stderr),
        }
    }
}

#[cfg(test)]
#[path = "command_runner_tests.rs"]
mod tests;
