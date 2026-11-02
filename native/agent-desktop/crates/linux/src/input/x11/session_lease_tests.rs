use std::process::Command;
use std::sync::{Arc, mpsc::channel};
use std::time::Duration;

use agent_desktop_core::{ErrorCode, acquire_unix_interaction_lease};

use super::{CallEnv, run_journaled};
use crate::input::x11::fake_sink::{FakeSink, deadline};

#[test]
fn session_lease_contender() {
    let Ok(expected) = std::env::var("AD_X11_SESSION_LEASE") else {
        return;
    };
    if expected == "blocked" {
        let path = format!("/tmp/agent-desktop-{}/interaction.lock", unsafe {
            libc::geteuid()
        });
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        assert!(matches!(
            file.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
    } else {
        acquire_unix_interaction_lease(deadline(30_000)).expect("cleanup freed the lease");
    }
}

fn contender(expected: &str) -> bool {
    const FILTER: &str = "input::x11::session::lease_tests::session_lease_contender";
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", FILTER, "--nocapture"])
        .env_remove(agent_desktop_core::INTERACTION_LEASE_FD_ENV)
        .env("AD_X11_SESSION_LEASE", expected)
        .output()
        .unwrap();
    output.status.success()
        && String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed")
}

#[test]
fn a_timed_out_input_worker_keeps_other_processes_out_until_exit() {
    let lease = acquire_unix_interaction_lease(deadline(30_000)).unwrap();
    let slot = Arc::default();
    let (started, ready) = channel();
    let (finish, wait) = channel();
    let error = run_journaled(
        move || {
            started.send(()).unwrap();
            wait.recv().unwrap();
            Ok(FakeSink::new())
        },
        Vec::new(),
        &mut || Ok(()),
        CallEnv {
            deadline: deadline(0),
            journal: None,
            slot: Arc::clone(&slot),
            release_on_signal: false,
            lease: Some(&lease),
        },
    )
    .expect_err("the caller timed out while its worker was blocked");
    ready.recv_timeout(Duration::from_secs(30)).unwrap();
    drop(lease);
    let blocked = contender("blocked");
    finish.send(()).unwrap();
    let _finished = slot.claim(deadline(30_000)).unwrap();
    assert!(contender("free"), "the worker must close its lease on exit");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(blocked, "another process overlapped the abandoned worker");
}
