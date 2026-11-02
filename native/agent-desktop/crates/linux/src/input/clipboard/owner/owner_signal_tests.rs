use std::cell::RefCell;
use std::io;

use super::*;

#[derive(Default)]
struct Fake {
    calls: RefCell<Vec<&'static str>>,
    open: Option<OpenFailure>,
    ticks: Option<u64>,
}

impl ProcessControl for Fake {
    type Handle = ();

    fn open(&self, _pid: u32) -> Result<(), OpenFailure> {
        self.calls.borrow_mut().push("open");
        self.open.map_or(Ok(()), Err)
    }

    fn start_ticks(&self, _pid: u32) -> Option<u64> {
        self.calls.borrow_mut().push("ticks");
        self.ticks
    }

    fn signal(&self, _handle: &()) -> io::Result<()> {
        self.calls.borrow_mut().push("signal");
        Ok(())
    }
}

fn record(pid: u32, start_ticks: u64) -> OwnerRecord {
    OwnerRecord {
        pid,
        start_ticks,
        display: ":7".into(),
        window: 1,
        nonce: "abcdefgh".into(),
    }
}

#[test]
fn a_live_record_is_signalled_after_the_handle_is_opened_and_the_start_time_checked() {
    let control = Fake {
        ticks: Some(500),
        ..Fake::default()
    };
    assert_eq!(
        stop_by_identity(&control, &record(40, 500)),
        Stopped::Signalled
    );
    assert_eq!(*control.calls.borrow(), ["open", "ticks", "signal"]);
}

#[test]
fn a_recycled_pid_is_never_signalled() {
    let control = Fake {
        ticks: Some(501),
        ..Fake::default()
    };
    assert_eq!(stop_by_identity(&control, &record(40, 500)), Stopped::Stale);
    assert!(!control.calls.borrow().contains(&"signal"));
}

#[test]
fn a_pid_that_is_gone_is_stale_and_not_signalled() {
    let control = Fake {
        open: Some(OpenFailure::Gone),
        ticks: Some(500),
        ..Fake::default()
    };
    assert_eq!(stop_by_identity(&control, &record(40, 500)), Stopped::Stale);
    assert_eq!(*control.calls.borrow(), ["open"]);
}

#[test]
fn without_handle_support_nothing_is_signalled() {
    let control = Fake {
        open: Some(OpenFailure::Unsupported),
        ticks: Some(500),
        ..Fake::default()
    };
    assert_eq!(
        stop_by_identity(&control, &record(40, 500)),
        Stopped::Unsupported
    );
    assert!(!control.calls.borrow().contains(&"signal"));
}

#[test]
fn a_record_with_pid_zero_is_never_opened() {
    let control = Fake {
        ticks: Some(0),
        ..Fake::default()
    };
    assert_eq!(stop_by_identity(&control, &record(0, 0)), Stopped::Stale);
    assert!(control.calls.borrow().is_empty());
}

#[test]
fn the_real_control_signals_a_matching_child_and_spares_a_mismatched_one() {
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("a sleeping child");
    let ticks = start_ticks_of(child.id()).expect("the child's start time");
    let wrong = record(child.id(), ticks.wrapping_add(7));
    assert_eq!(stop_by_identity(&PidfdControl, &wrong), Stopped::Stale);
    assert!(child.try_wait().expect("a status").is_none());
    let right = record(child.id(), ticks);
    assert_eq!(stop_by_identity(&PidfdControl, &right), Stopped::Signalled);
    let status = child.wait().expect("the child ends");
    assert!(!status.success());
}
