use std::cell::RefCell;
use std::collections::VecDeque;

use agent_desktop_core::system::process_state::ProcessState::{
    self, Exited, Running, Unresponsive,
};

use super::{Observer, observe};
use crate::system::process::liveness::Liveness::{self, Alive, Gone, Stopped};
use crate::system::process::process_state_classify::Probe::{
    self, Answered, TimedOut, Unavailable,
};

struct Script {
    liveness: RefCell<VecDeque<Liveness>>,
    probes: RefCell<VecDeque<Probe>>,
    expired: bool,
}

impl Script {
    fn new(liveness: &[Liveness], probes: &[Probe], expired: bool) -> Self {
        Self {
            liveness: RefCell::new(liveness.iter().copied().collect()),
            probes: RefCell::new(probes.iter().copied().collect()),
            expired,
        }
    }
}

impl Observer for Script {
    fn liveness(&self) -> Liveness {
        self.liveness.borrow_mut().pop_front().unwrap()
    }

    fn probe(&self) -> Probe {
        self.probes.borrow_mut().pop_front().expect("probe")
    }

    fn expired(&self) -> bool {
        self.expired
    }
}

#[test]
fn process_state_observes_identity_again_and_respects_probe_evidence_and_deadline() {
    let cases: &[(&[Liveness], &[Probe], bool, ProcessState)] = &[
        (&[Gone], &[], false, Exited { code: None }),
        (&[Alive, Gone], &[Answered], false, Exited { code: None }),
        (&[Stopped, Stopped], &[Unavailable], false, Unresponsive),
        (&[Stopped, Stopped], &[TimedOut], false, Unresponsive),
        (&[Stopped, Stopped], &[Answered], false, Running),
        (&[Alive, Alive], &[Unavailable], false, Running),
        (&[Alive, Alive], &[TimedOut, Unavailable], false, Running),
        (&[Alive, Alive], &[TimedOut, TimedOut], false, Unresponsive),
        (&[Alive, Alive], &[TimedOut, Answered], false, Running),
        (&[Alive, Alive], &[TimedOut], true, Running),
        (
            &[Alive, Stopped],
            &[TimedOut, TimedOut],
            false,
            Unresponsive,
        ),
    ];

    for (index, (liveness, probes, expired, expected)) in cases.iter().enumerate() {
        let observer = Script::new(liveness, probes, *expired);
        assert_eq!(observe(&observer), *expected, "case {index}");
        assert!(observer.liveness.borrow().is_empty(), "case {index}");
        assert!(observer.probes.borrow().is_empty(), "case {index}: probes");
    }
}
