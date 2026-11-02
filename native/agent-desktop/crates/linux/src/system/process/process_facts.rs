use crate::system::process::process_lookup::Lookup;
use std::path::Path;
use std::sync::OnceLock;

use super::proc_stat;

const BOOT_ID_PREFIX_LEN: usize = 8;

/// What `/proc` knows about one process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessFacts {
    pub(crate) executable: Option<super::executable_identity::ExecutableIdentity>,
    pub(crate) comm: String,
    pub(crate) exe_basename: Option<String>,
    pub(crate) instance: String,
}

pub(crate) const ESRCH: i32 = 3;

/// Whether a failed `/proc` read says the process has exited, as opposed to
/// the read having failed for another reason.
pub(crate) fn lookup_for_error(error: &std::io::Error) -> Lookup {
    if error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(ESRCH) {
        Lookup::Gone
    } else {
        Lookup::Unreadable
    }
}

/// The token that tells two runs of one process id apart: a prefix of the
/// boot id, so it differs across reboots, and the start time.
pub(crate) fn process_instance(boot_id: &str, start_time: u64) -> String {
    let prefix: String = boot_id.trim().chars().take(BOOT_ID_PREFIX_LEN).collect();
    format!("{prefix}:{start_time}")
}

/// The token for a start time on this boot.
pub(crate) fn instance_token(start_time: u64) -> String {
    process_instance(boot_id(), start_time)
}

fn boot_id() -> &'static str {
    static BOOT_ID: OnceLock<String> = OnceLock::new();
    BOOT_ID.get_or_init(|| {
        std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap_or_default()
    })
}

/// The facts of a running process, or `None` when it has gone or could not be
/// read.
pub(crate) fn read(pid: u32) -> Option<ProcessFacts> {
    match inspect(pid) {
        Lookup::Found(facts) => Some(facts),
        _ => None,
    }
}

/// Looks one process up. A made-up start time would let a recycled id pass,
/// so a stat line without a readable start time is `Unreadable`, and only a
/// read that failed because the process has gone is `Gone`.
pub(crate) fn lookup(pid: u32) -> Lookup {
    inspect(pid)
}

fn inspect(pid: u32) -> Lookup {
    let stat = match proc_stat::read_stat(pid) {
        Ok(Some(stat)) => stat,
        Ok(None) => return Lookup::Gone,
        Err(()) => return Lookup::Unreadable,
    };
    let comm = match std::fs::read_to_string(format!("/proc/{pid}/comm")) {
        Ok(comm) => comm.trim_end().to_owned(),
        Err(error) => return lookup_for_error(&error),
    };
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok();
    let exe_basename = exe
        .as_deref()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned());
    let facts = ProcessFacts {
        executable: super::executable_identity::ExecutableIdentity::read(pid),
        comm,
        exe_basename,
        instance: process_instance(boot_id(), stat.start_time),
    };
    Lookup::Found(facts)
}

#[cfg(test)]
#[path = "process_facts_tests.rs"]
mod tests;
