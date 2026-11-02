use std::collections::VecDeque;
use std::fs;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::process::Stdio;

use agent_desktop_core::Deadline;
use rustix::io::{FdFlags, fcntl_getfd};

use super::*;
use crate::input::clipboard::owner::owner_spawn_spec::build_command;
use crate::input::clipboard::payload::unframe;
use crate::input::clipboard::target::Target;
use crate::input::clipboard::test_nonce::test_nonce;

struct Script {
    outcomes: VecDeque<Option<Outcome>>,
    exit: Option<String>,
}

impl HandshakeProbe for Script {
    fn outcome(&mut self) -> Option<Outcome> {
        self.outcomes.pop_front().flatten()
    }

    fn exit_reason(&mut self) -> Option<String> {
        self.exit.clone()
    }
}

fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("a deadline")
}

#[test]
fn a_record_written_on_the_way_out_still_counts_when_the_child_has_exited() {
    let mut probe = Script {
        outcomes: VecDeque::from([None, Some(Outcome::Failed("late".into()))]),
        exit: Some("status 1".into()),
    };
    assert_eq!(
        await_handshake(&mut probe, deadline(2_000)),
        Handshake::Failed("late".into())
    );
}

fn sample() -> Payload {
    Payload {
        targets: vec![Target {
            name: "UTF8_STRING".into(),
            bytes: b"secret text".to_vec(),
        }],
    }
}

fn close_on_exec(descriptor: &OwnedFd) -> bool {
    fcntl_getfd(descriptor)
        .expect("flags")
        .contains(FdFlags::CLOEXEC)
}

fn no_environment(_: &str) -> Option<String> {
    None
}

#[test]
fn the_payload_file_is_anonymous_close_on_exec_and_holds_the_framed_payload() {
    let nonce = test_nonce();
    let descriptor = payload_file(&sample(), &nonce).expect("a payload file");
    let link = fs::read_link(format!("/proc/self/fd/{}", descriptor.as_raw_fd()))
        .expect("the descriptor names a file");
    assert!(
        link.to_string_lossy().starts_with("/memfd:ad-payload-"),
        "{link:?}"
    );
    assert!(close_on_exec(&descriptor));
    let mut reopened =
        File::open(format!("/proc/self/fd/{}", descriptor.as_raw_fd())).expect("reopen");
    let mut bytes = Vec::new();
    reopened.read_to_end(&mut bytes).expect("read");
    assert_eq!(unframe(&bytes).expect("a payload"), sample());
}

#[test]
fn the_payload_stays_close_on_exec_here_and_is_open_and_readable_in_the_child() {
    let nonce = test_nonce();
    let descriptor = payload_file(&sample(), &nonce).expect("a payload file");
    let number = descriptor.as_raw_fd();
    let mut command = build_command(
        Path::new("/bin/cat"),
        ":77",
        &nonce,
        number,
        &no_environment,
    );
    assert!(close_on_exec(&descriptor), "after the command is built");
    let output = command
        .arg(format!("/proc/self/fd/{number}"))
        .stdout(Stdio::piped())
        .output()
        .expect("the child ran");
    assert!(output.status.success(), "{:?}", output.status);
    assert_eq!(unframe(&output.stdout).expect("a payload"), sample());
    assert!(close_on_exec(&descriptor), "after the child ran");
}

#[test]
fn nonces_are_valid_record_nonces_and_differ() {
    let first = new_nonce();
    let second = new_nonce();
    assert!(owner_record::valid_nonce(&first), "{first}");
    assert_ne!(first, second);
}

#[test]
fn a_finished_owner_is_reaped_and_leaves_no_zombie() {
    let child = std::process::Command::new("true").spawn().expect("a child");
    let pid = child.id();
    reap_when_done(child).expect("a reaper thread");
    let gone = (0..200).any(|_| {
        sleep(Duration::from_millis(25));
        !Path::new(&format!("/proc/{pid}")).exists()
    });
    assert!(gone, "the finished child must be collected");
}
