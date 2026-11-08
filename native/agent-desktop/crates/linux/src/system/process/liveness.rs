use super::identity::Identity;
use super::proc_stat::ProcStat;
use super::{proc_stat, process_facts};
use crate::system::process::proc_state::ProcState;

/// Whether a process is running, stopped, or no longer there. A zombie and a
/// recycled process id are `Gone`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Liveness {
    Alive,
    Stopped,
    Gone,
}

/// The verdict from one stat read. A missing entry, a zombie and a dead
/// process are `Gone`; so is a process whose token differs, because it is
/// not the one the caller meant. `kill(pid, 0)` is no substitute: it
/// succeeds on a zombie.
pub(in crate::system) fn verdict(stat: Option<ProcStat>, expected: &str) -> Liveness {
    let Some(stat) = stat else {
        return Liveness::Gone;
    };
    match stat.state {
        ProcState::Zombie | ProcState::Dead => Liveness::Gone,
        _ if process_facts::instance_token(stat.start_time) != expected => Liveness::Gone,
        ProcState::Stopped => Liveness::Stopped,
        _ => Liveness::Alive,
    }
}

/// As [`verdict`] but keeping a replaced process apart from one that left,
/// for the caller that must not signal the first.
pub(in crate::system) fn identity_of(
    stat: Result<Option<ProcStat>, ()>,
    expected: &str,
) -> Identity {
    match stat {
        Err(()) => Identity::Unreadable,
        Ok(None) => Identity::Gone,
        Ok(Some(stat)) if matches!(stat.state, ProcState::Zombie | ProcState::Dead) => {
            Identity::Gone
        }
        Ok(Some(stat)) if process_facts::instance_token(stat.start_time) != expected => {
            Identity::Replaced
        }
        Ok(Some(_)) => Identity::Same,
    }
}

/// The identity of the process id right now.
pub(crate) fn identity(pid: u32, instance: &str) -> Identity {
    identity_of(proc_stat::read_stat(pid), instance)
}

/// Whether the process the caller saw is running, stopped, or gone. A stat
/// that cannot be read says the process is still there: only evidence of an
/// exit may end a wait or a close.
pub(crate) fn liveness(pid: u32, instance: &str) -> Liveness {
    match proc_stat::read_stat(pid) {
        Ok(stat) => verdict(stat, instance),
        Err(()) => Liveness::Alive,
    }
}

#[cfg(test)]
#[path = "liveness_tests.rs"]
mod tests;
