use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use rustix::process::{Pid, Signal, kill_process};

use super::*;

static NEXT: AtomicU32 = AtomicU32::new(0);

struct Dir(PathBuf);

impl Dir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ad-runner-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&path).expect("a scratch directory");
        Self(path)
    }

    fn script(&self, body: &str) -> PathBuf {
        let path = self.0.join("tool");
        crate::input::clipboard::test_script::write_executable(
            &path,
            &format!("#!/bin/sh\n{body}\n"),
        );
        path
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn spec(program: PathBuf, stdin: Option<&[u8]>, capture: bool) -> RunSpec {
    RunSpec {
        program,
        args: Vec::new(),
        stdin: stdin.map(<[u8]>::to_vec),
        capture_stdout: capture,
    }
}

fn runner() -> ProcessRunner {
    ProcessRunner { env: Vec::new() }
}

fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("a deadline")
}

fn alive(pid: i32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn stop_by_pid(pid: i32) {
    if let Some(pid) = Pid::from_raw(pid) {
        let _ = kill_process(pid, Signal::KILL);
    }
}

#[test]
fn stdout_stderr_and_the_exit_code_come_back() {
    let dir = Dir::new();
    let tool = dir.script("echo out; echo oops >&2; exit 3");
    let outcome = runner().run(&spec(tool, None, true), deadline(5_000));
    assert_eq!(
        outcome,
        RunOutcome::Exited {
            code: Some(3),
            stdout: b"out\n".to_vec(),
            stderr: "oops\n".into()
        }
    );
}

#[test]
fn the_payload_reaches_standard_input() {
    let dir = Dir::new();
    let tool = dir.script("cat");
    let outcome = runner().run(&spec(tool, Some(b"secret\x00bytes"), true), deadline(5_000));
    assert!(matches!(
        outcome,
        RunOutcome::Exited { code: Some(0), ref stdout, .. } if stdout == b"secret\x00bytes"
    ));
}

#[test]
fn a_program_that_never_finishes_is_killed_at_the_deadline() {
    let dir = Dir::new();
    let pid_file = dir.0.join("pid");
    let tool = dir.script(&format!("echo $$ > {}\nexec sleep 30", pid_file.display()));
    let started = std::time::Instant::now();
    let outcome = runner().run(&spec(tool, None, false), deadline(300));
    assert_eq!(outcome, RunOutcome::TimedOut);
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    let pid: i32 = fs::read_to_string(&pid_file)
        .expect("a pid")
        .trim()
        .parse()
        .expect("a number");
    assert!(!alive(pid), "the child must be gone after the timeout");
}

#[test]
fn a_server_left_holding_the_pipes_is_not_waited_for() {
    let dir = Dir::new();
    let pid_file = dir.0.join("server");
    let tool = dir.script(&format!(
        "sleep 30 &\necho $! > {}\nexit 0",
        pid_file.display()
    ));
    let outcome = runner().run(&spec(tool, Some(b"x"), false), deadline(10_000));
    let server: i32 = fs::read_to_string(&pid_file)
        .expect("a pid")
        .trim()
        .parse()
        .expect("a number");
    stop_by_pid(server);
    assert!(matches!(outcome, RunOutcome::Exited { code: Some(0), .. }));
}

#[test]
fn output_over_the_cap_is_cut_off() {
    let dir = Dir::new();
    let tool = dir.script("exec head -c 70000000 /dev/zero");
    let outcome = runner().run(&spec(tool, None, true), deadline(20_000));
    assert_eq!(outcome, RunOutcome::OverCap);
}

#[test]
fn a_missing_program_does_not_start() {
    let outcome = runner().run(
        &spec(PathBuf::from("/nonexistent/ad-tool"), None, false),
        deadline(1_000),
    );
    assert!(matches!(outcome, RunOutcome::NotStarted(_)));
}

#[test]
fn a_signal_exit_has_no_code() {
    let dir = Dir::new();
    let tool = dir.script("kill -KILL $$");
    let outcome = runner().run(&spec(tool, None, false), deadline(5_000));
    assert!(matches!(outcome, RunOutcome::Exited { code: None, .. }));
}

#[test]
fn the_runner_adds_only_the_environment_it_was_given() {
    let dir = Dir::new();
    let tool = dir.script("printf %s \"$AD_RUNNER_PROBE\"");
    let runner = ProcessRunner {
        env: vec![("AD_RUNNER_PROBE".into(), "set".into())],
    };
    let outcome = runner.run(&spec(tool, None, true), deadline(5_000));
    assert!(matches!(
        outcome,
        RunOutcome::Exited { ref stdout, .. } if stdout == b"set"
    ));
}
