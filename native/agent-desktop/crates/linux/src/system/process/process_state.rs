use agent_desktop_core::system::process_state::ProcessState;
use agent_desktop_core::{AdapterError, Deadline, ProcessIdentity};

use super::liveness::{Liveness, liveness};
use super::process_state_classify::Probe;
use crate::system::SharedBus;
use crate::system::registry::read_registry_for;

/// What `process_state` reads: kernel liveness and accessibility probes.
/// Split out so the order of the reads can be tested.
pub(in crate::system) trait Observer {
    fn liveness(&self) -> Liveness;
    fn probe(&self) -> Probe;
    fn expired(&self) -> bool;
}

struct Live<'a> {
    bus: &'a SharedBus,
    pid: u32,
    instance: &'a str,
    deadline: Deadline,
}

impl Observer for Live<'_> {
    fn liveness(&self) -> Liveness {
        liveness(self.pid, self.instance)
    }

    fn probe(&self) -> Probe {
        if self.deadline.is_expired() {
            return Probe::Unavailable;
        }
        let Ok(registry) = read_registry_for(self.bus, Some(self.pid), self.deadline) else {
            return Probe::Unavailable;
        };
        let mut found = registry
            .apps
            .iter()
            .filter(|app| app.root.pid() == self.pid)
            .peekable();
        if found.peek().is_none() {
            Probe::Unavailable
        } else if found.any(|app| app.answered) {
            Probe::Answered
        } else {
            Probe::TimedOut
        }
    }

    fn expired(&self) -> bool {
        self.deadline.is_expired()
    }
}

/// The liveness answer. It never returns an error: a probe that cannot run
/// leaves the kernel's answer standing, and the token is read again after
/// the probes so a process id recycled meanwhile reads as exited.
pub(in crate::system) fn observe(observer: &impl Observer) -> ProcessState {
    let first = observer.liveness();
    if first == Liveness::Gone {
        return ProcessState::Exited { code: None };
    }
    let first_probe = observer.probe();
    let second_probe =
        if first == Liveness::Alive && first_probe == Probe::TimedOut && !observer.expired() {
            Some(observer.probe())
        } else {
            None
        };
    let final_liveness = observer.liveness();
    let answered = first_probe == Probe::Answered || second_probe == Some(Probe::Answered);
    let blocked = first_probe == Probe::TimedOut && second_probe == Some(Probe::TimedOut);
    match final_liveness {
        Liveness::Gone => ProcessState::Exited { code: None },
        Liveness::Stopped if answered => ProcessState::Running,
        Liveness::Stopped => ProcessState::Unresponsive,
        Liveness::Alive if !answered && blocked => ProcessState::Unresponsive,
        Liveness::Alive => ProcessState::Running,
    }
}

pub(crate) fn process_state(
    bus: &SharedBus,
    process: ProcessIdentity,
    deadline: Deadline,
) -> Result<ProcessState, AdapterError> {
    let live = Live {
        bus,
        pid: process.pid.get(),
        instance: &process.instance,
        deadline,
    };
    Ok(observe(&live))
}

#[cfg(test)]
#[path = "process_state_tests.rs"]
mod tests;
