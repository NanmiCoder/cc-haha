use agent_desktop_core::refs::resolve_errors::identity_unknown_error;
use agent_desktop_core::{AdapterError, RefEntry};

use super::resolve_errors::{app_exited, owner_unreachable, window_replaced, window_unverifiable};
use crate::system::process::process_lookup::Lookup;
use crate::system::window::window_id;
use crate::tree::AtspiElement;
use crate::tree::element::ancestry;
use crate::tree::properties::absence::failure;
use crate::tree::properties::failure::Failure;

/// The window a ref was taken in, as its stored evidence names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoredWindow {
    bus: String,
    path: String,
    pid: u32,
    instance: String,
}

/// Reads the window a ref names from its stored evidence. A ref with no window
/// id, an id this adapter did not issue, or no process-instance token cannot
/// vouch for its window and is refused as core's action path refuses it.
pub(crate) fn stored_window(entry: &RefEntry) -> Result<StoredWindow, AdapterError> {
    let id = entry
        .source
        .source_window_id
        .as_deref()
        .ok_or_else(window_unverifiable)?;
    let (bus, path) = window_id::decode(id).map_err(|_| window_unverifiable())?;
    let instance = entry
        .process
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
        .ok_or_else(window_unverifiable)?;
    Ok(StoredWindow {
        bus,
        path,
        pid: entry.process.pid.get(),
        instance: instance.to_owned(),
    })
}

impl StoredWindow {
    pub(crate) fn pid(&self) -> u32 {
        self.pid
    }

    pub(crate) fn bus(&self) -> &str {
        &self.bus
    }

    /// The window root, its own frame, at the address the id was made from.
    pub(crate) fn frame(&self) -> AtspiElement {
        let mut frame = AtspiElement::new(self.bus.as_str(), self.path.as_str(), self.pid);
        frame.set_ancestry(ancestry::of_root(&frame));
        frame
    }

    /// Checks the process the window id points at is the one the ref was taken
    /// from: a pid with no `/proc` entry has exited, a start time that differs
    /// is a restarted application that reuses the pid, and a process that
    /// `/proc` could not be read for is unidentified and retried, never
    /// declared gone.
    pub(crate) fn check_process(
        &self,
        live: &Lookup,
        entry: &RefEntry,
    ) -> Result<(), AdapterError> {
        match live {
            Lookup::Gone => Err(app_exited()),
            Lookup::Unreadable => Err(identity_unknown_error(entry)),
            Lookup::Found(facts) if facts.instance == self.instance => Ok(()),
            Lookup::Found(_) => Err(window_replaced()),
        }
    }

    /// Checks the bus name's owner is the stored process. The owner is asked
    /// for after the frame answered, so a lookup that fails other than by the
    /// name having no owner leaves the window unidentified, which is retried.
    pub(crate) fn check_owner(
        &self,
        owner: Result<u32, zbus::Error>,
        entry: &RefEntry,
    ) -> Result<(), AdapterError> {
        match owner {
            Ok(pid) if pid == self.pid => Ok(()),
            Ok(_) => Err(window_replaced()),
            Err(error) => match failure(&error) {
                Failure::AppGone => Err(owner_unreachable(self.pid)),
                Failure::TimedOut => Err(AdapterError::timeout(
                    "The bus did not name the owner of the window in time",
                )
                .with_platform_detail(error.to_string())),
                Failure::Suspect | Failure::Other => Err(identity_unknown_error(entry)),
            },
        }
    }
}

#[cfg(test)]
#[path = "resolve_gate_tests.rs"]
mod tests;
