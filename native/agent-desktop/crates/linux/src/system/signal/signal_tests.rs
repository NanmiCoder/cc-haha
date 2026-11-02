use std::cell::{Cell, RefCell};

use agent_desktop_core::{DeliverySemantics, ErrorCode};

use super::{Kernel, Sent, Signal, send_through};
use crate::system::process::identity::Identity;

struct Fake {
    identities: RefCell<Vec<Identity>>,
    open: Result<(), i32>,
    deliver: Result<(), i32>,
    delivered: Cell<u32>,
    opened: Cell<u32>,
}

impl Fake {
    fn new(identities: &[Identity]) -> Self {
        let mut queue = identities.to_vec();
        queue.reverse();
        Self {
            identities: RefCell::new(queue),
            open: Ok(()),
            deliver: Ok(()),
            delivered: Cell::new(0),
            opened: Cell::new(0),
        }
    }
}

impl Kernel for Fake {
    type Handle = ();

    fn identity(&self, _pid: u32, _instance: &str) -> Identity {
        self.identities
            .borrow_mut()
            .pop()
            .expect("the flow read the token more often than the test expected")
    }

    fn open(&self, _pid: u32) -> Result<(), i32> {
        self.opened.set(self.opened.get() + 1);
        self.open
    }

    fn deliver(&self, _handle: &(), _signal: Signal) -> Result<(), i32> {
        self.delivered.set(self.delivered.get() + 1);
        self.deliver
    }
}

#[test]
fn a_wrong_token_is_replaced_and_nothing_is_opened_or_sent() {
    let kernel = Fake::new(&[Identity::Replaced]);
    let sent = send_through(&kernel, 7, "t", Signal::Kill).expect("answers");
    assert_eq!(sent, Sent::Replaced);
    assert_eq!(kernel.opened.get(), 0);
    assert_eq!(kernel.delivered.get(), 0);
}

#[test]
fn a_process_id_recycled_while_the_descriptor_opened_is_not_signalled() {
    let kernel = Fake::new(&[Identity::Same, Identity::Replaced]);
    let sent = send_through(&kernel, 7, "t", Signal::Kill).expect("answers");
    assert_eq!(sent, Sent::Replaced);
    assert_eq!(kernel.opened.get(), 1);
    assert_eq!(kernel.delivered.get(), 0);
}

#[test]
fn a_process_that_exited_is_already_gone_at_each_step() {
    let first = Fake::new(&[Identity::Gone]);
    assert_eq!(
        send_through(&first, 7, "t", Signal::Term).expect("answers"),
        Sent::AlreadyGone
    );
    let mut at_open = Fake::new(&[Identity::Same]);
    at_open.open = Err(3);
    assert_eq!(
        send_through(&at_open, 7, "t", Signal::Term).expect("answers"),
        Sent::AlreadyGone
    );
    let second = Fake::new(&[Identity::Same, Identity::Gone]);
    assert_eq!(
        send_through(&second, 7, "t", Signal::Term).expect("answers"),
        Sent::AlreadyGone
    );
    let mut at_send = Fake::new(&[Identity::Same, Identity::Same]);
    at_send.deliver = Err(3);
    assert_eq!(
        send_through(&at_send, 7, "t", Signal::Term).expect("answers"),
        Sent::AlreadyGone
    );
}

#[test]
fn a_refused_signal_is_action_failed_not_delivered_with_the_errno() {
    let mut kernel = Fake::new(&[Identity::Same, Identity::Same]);
    kernel.deliver = Err(1);
    let error = send_through(&kernel, 7, "t", Signal::Term).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let detail = error.platform_detail.expect("the errno is named");
    assert!(detail.contains("errno 1"), "{detail}");
}

#[test]
fn a_refused_descriptor_is_action_failed_not_delivered() {
    let mut kernel = Fake::new(&[Identity::Same]);
    kernel.open = Err(38);
    let error = send_through(&kernel, 7, "t", Signal::Term).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(error.platform_detail.expect("detail").contains("errno 38"));
}

#[test]
fn an_unreadable_identity_sends_nothing() {
    let kernel = Fake::new(&[Identity::Unreadable]);
    let error = send_through(&kernel, 7, "t", Signal::Term).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(kernel.delivered.get(), 0);
}

#[cfg(target_os = "linux")]
mod live {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use super::super::{Sent, Signal, send};
    use crate::system::process::process_facts;

    fn spawn() -> std::process::Child {
        Command::new("sleep")
            .arg("60")
            .stdin(Stdio::null())
            .spawn()
            .expect("sleep spawns")
    }

    #[test]
    fn the_right_token_ends_the_child() {
        let mut child = spawn();
        let token = process_facts::read(child.id()).expect("runs").instance;
        assert_eq!(
            send(child.id(), &token, Signal::Term).expect("sends"),
            Sent::Delivered
        );
        let started = Instant::now();
        while child.try_wait().expect("polls").is_none() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "the child exits"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_wrong_token_leaves_the_child_running() {
        let mut child = spawn();
        assert_eq!(
            send(child.id(), "0000:1", Signal::Kill).expect("answers"),
            Sent::Replaced
        );
        std::thread::sleep(Duration::from_millis(100));
        assert!(child.try_wait().expect("polls").is_none());
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn an_exited_child_is_already_gone() {
        let mut child = spawn();
        let token = process_facts::read(child.id()).expect("runs").instance;
        child.kill().expect("kills");
        child.wait().expect("reaps");
        assert_eq!(
            send(child.id(), &token, Signal::Term).expect("answers"),
            Sent::AlreadyGone
        );
    }
}
