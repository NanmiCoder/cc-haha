use std::process::Command;
use std::sync::{Arc, mpsc::channel};
use std::time::Duration;

use super::start_sweep;
use crate::input::x11::worker_slot::WorkerSlot;
use crate::system::interaction::interaction_lease;
use agent_desktop_core::Deadline;

fn deadline(ms: u64) -> Deadline {
    Deadline::detached_after(ms).expect("deadline")
}

#[test]
fn a_timed_out_sweep_keeps_its_slot_until_cleanup_finishes() {
    let slot = Arc::new(WorkerSlot::default());
    let (started, ready) = channel();
    let (finish, wait) = channel();
    let pending = start_sweep(deadline(5_000), Arc::clone(&slot), move || {
        started.send(()).unwrap();
        wait.recv().unwrap();
    })
    .unwrap();
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(pending.finish(deadline(0)).is_none());
    let blocked = slot.claim(deadline(0)).is_err();
    finish.send(()).unwrap();
    let _next = slot.claim(deadline(5_000)).expect("cleanup freed the slot");
    assert!(
        blocked,
        "the caller timeout must not free the worker's slot"
    );
}

#[test]
fn sweep_lease_contender() {
    let Ok(blocked) = std::env::var("AD_SWEEP_CONTENDER") else {
        return;
    };
    let result = interaction_lease::acquire(deadline(if blocked == "yes" { 100 } else { 5_000 }));
    assert_eq!(result.is_err(), blocked == "yes");
}

fn contender(blocked: bool) -> bool {
    const FILTER: &str = "input::x11::stale_release::tests::sweep_lease_contender";
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", FILTER, "--nocapture"])
        .env("AD_SWEEP_CONTENDER", if blocked { "yes" } else { "no" })
        .output()
        .unwrap();
    output.status.success()
        && String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed")
}

#[test]
fn a_timed_out_sweep_orders_other_processes_after_cleanup() {
    let (started, ready) = channel();
    let (finish, wait) = channel();
    let pending = start_sweep(deadline(5_000), Arc::default(), move || {
        started.send(()).unwrap();
        wait.recv().unwrap();
    })
    .unwrap();
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(pending.finish(deadline(0)).is_none());
    let blocked = contender(true);
    finish.send(()).unwrap();
    assert!(contender(false), "the next process must run after cleanup");
    assert!(blocked, "another process must not overlap cleanup");
}
