use std::cell::Cell;

use super::*;

#[test]
fn a_recycled_xid_is_not_closed() {
    let current_pid = Cell::new(Some(42));
    let target = agent_desktop_core::ProcessIdentity {
        pid: current_pid.get().expect("the inventoried owner").into(),
        instance: "original".to_owned(),
    };
    for replacement in [Some(99), None] {
        current_pid.set(replacement);
        let sent = Cell::new(false);
        let outcome = with_owner(
            &target,
            || Ok(()),
            || current_pid.get(),
            |_, _| Identity::Same,
            || {
                sent.set(true);
                Ok(())
            },
        );
        assert_eq!(outcome, Err(ControlError::StaleWindow));
        assert!(!sent.get(), "no close may reach the replacement client");
    }
}

#[test]
fn a_recycled_or_unreadable_process_is_not_closed() {
    let target = agent_desktop_core::ProcessIdentity {
        pid: 42.into(),
        instance: "original".to_owned(),
    };
    for identity in [Identity::Replaced, Identity::Gone, Identity::Unreadable] {
        let sent = Cell::new(false);
        let outcome = with_owner(
            &target,
            || Ok(()),
            || Some(42),
            |pid, instance| {
                assert_eq!((pid, instance), (42, "original"));
                identity
            },
            || {
                sent.set(true);
                Ok(())
            },
        );
        assert_eq!(outcome, Err(ControlError::StaleWindow));
        assert!(!sent.get());
    }
}

#[test]
fn a_current_owner_receives_close_and_retains_send_errors() {
    let target = agent_desktop_core::ProcessIdentity {
        pid: 42.into(),
        instance: "original".to_owned(),
    };
    for result in [Ok(()), Err(ControlError::SendFailed)] {
        let sent = Cell::new(0);
        let outcome = with_owner(
            &target,
            || Ok(()),
            || Some(42),
            |pid, instance| {
                assert_eq!((pid, instance), (42, "original"));
                Identity::Same
            },
            || {
                sent.set(sent.get() + 1);
                result
            },
        );
        assert_eq!(outcome, result);
        assert_eq!(sent.get(), 1);
    }
}

#[test]
fn close_validation_and_dispatch_hold_the_server_grab() {
    struct Grab<'a> {
        grabbed: &'a Cell<bool>,
        pid: &'a Cell<u32>,
        pending_reuse: &'a Cell<bool>,
    }

    impl Drop for Grab<'_> {
        fn drop(&mut self) {
            self.grabbed.set(false);
            if self.pending_reuse.get() {
                self.pid.set(99);
            }
        }
    }

    let grabbed = Cell::new(false);
    let pid = Cell::new(42);
    let pending_reuse = Cell::new(false);
    let sent_to = Cell::new(None);
    let target = agent_desktop_core::ProcessIdentity {
        pid: 42.into(),
        instance: "original".to_owned(),
    };
    with_owner(
        &target,
        || {
            grabbed.set(true);
            Ok(Grab {
                grabbed: &grabbed,
                pid: &pid,
                pending_reuse: &pending_reuse,
            })
        },
        || Some(pid.get()),
        |_, _| {
            if grabbed.get() {
                pending_reuse.set(true);
            } else {
                pid.set(99);
            }
            Identity::Same
        },
        || {
            sent_to.set(Some(pid.get()));
            Ok(())
        },
    )
    .expect("close dispatched before reuse");
    assert_eq!(sent_to.get(), Some(42));
    assert!(!grabbed.get());
    assert_eq!(pid.get(), 99, "reuse resumes after dispatch");
}

#[test]
fn a_failed_server_grab_sends_nothing() {
    let target = agent_desktop_core::ProcessIdentity {
        pid: 42.into(),
        instance: "original".to_owned(),
    };
    let outcome: Result<(), _> = with_owner(
        &target,
        || Err::<(), _>(ControlError::SendFailed),
        || panic!("must not read the owner without a server grab"),
        |_, _| panic!("must not read the process without a server grab"),
        || panic!("must not send without a server grab"),
    );
    assert_eq!(outcome, Err(ControlError::SendFailed));
}
