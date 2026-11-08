use super::process_facts;
use crate::system::app::app_alias::current_index;
use crate::system::app::app_name::{aliases_in, app_name, name_matches};

const BUS_VARIABLE: &str = "DBUS_SESSION_BUS_ADDRESS";
const STARTER_VARIABLE: &str = "DBUS_STARTER_ADDRESS";
const RUNTIME_VARIABLE: &str = "XDG_RUNTIME_DIR";

/// What names this session: its session bus and its runtime directory. A
/// process of another session, even of the same user, carries other values.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::system) struct SessionKey {
    bus: Option<String>,
    runtime: Option<String>,
}

impl SessionKey {
    pub(in crate::system) fn of_this_process() -> Self {
        Self {
            bus: std::env::var(BUS_VARIABLE).ok().filter(|v| !v.is_empty()),
            runtime: std::env::var(RUNTIME_VARIABLE)
                .ok()
                .filter(|v| !v.is_empty()),
        }
    }

    /// Whether a process with this environment belongs to the session. A
    /// process whose environment cannot be read does not. When this process
    /// itself names neither, there is no session to tell apart.
    pub(in crate::system) fn owns(&self, environ: Option<&[u8]>) -> bool {
        if self.bus.is_none() && self.runtime.is_none() {
            return true;
        }
        let Some(environ) = environ else {
            return false;
        };
        environ
            .split(|byte| *byte == 0)
            .filter_map(|entry| std::str::from_utf8(entry).ok()?.split_once('='))
            .any(|(name, value)| match name {
                BUS_VARIABLE | STARTER_VARIABLE => self.bus.as_deref() == Some(value),
                RUNTIME_VARIABLE => self.runtime.as_deref() == Some(value),
                _ => false,
            })
    }
}

/// A running process of this session whose `comm`, executable basename or
/// desktop entry name is `query`, found by scanning `/proc`: its process id
/// and `comm`. A process of another session never matches.
pub(crate) fn find_running(query: &str) -> Option<(u32, String)> {
    find_in_session(query, &SessionKey::of_this_process())
}

fn find_in_session(query: &str, session: &SessionKey) -> Option<(u32, String)> {
    find_with_environ(query, session, &|pid| {
        std::fs::read(format!("/proc/{pid}/environ")).ok()
    })
}

fn find_with_environ(
    query: &str,
    session: &SessionKey,
    environ_of: &dyn Fn(u32) -> Option<Vec<u8>>,
) -> Option<(u32, String)> {
    let index = current_index();
    std::fs::read_dir("/proc")
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
        .find_map(|pid| {
            if (session.bus.is_some() || session.runtime.is_some())
                && !session.owns(environ_of(pid).as_deref())
            {
                return None;
            }
            let facts = process_facts::read(pid)?;
            let matched = name_matches(query, &app_name(&facts), &aliases_in(&index, &facts));
            matched.then(|| (pid, facts.comm.clone()))
        })
}

#[cfg(test)]
#[path = "proc_scan_tests.rs"]
mod tests;
