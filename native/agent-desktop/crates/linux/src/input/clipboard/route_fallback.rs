use std::ffi::OsString;

use agent_desktop_core::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, InteractionLease,
};

use super::command_runner::ProcessRunner;
use super::wayland::Wayland;

#[derive(Debug, Clone, Default)]
pub(crate) struct ClipboardTools {
    pub(crate) search_path: Option<OsString>,
}

impl ClipboardTools {
    pub(crate) fn from_process() -> Self {
        Self {
            search_path: std::env::var_os("PATH"),
        }
    }

    pub(crate) fn read(
        &self,
        format: ClipboardFormat,
        deadline: Deadline,
    ) -> Result<Option<ClipboardContent>, AdapterError> {
        Wayland {
            runner: &ProcessRunner { env: Vec::new() },
            search_path: self.search_path.clone(),
        }
        .read(format, deadline)
    }

    pub(crate) fn set(
        &self,
        content: &ClipboardContent,
        lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        Wayland {
            runner: &ProcessRunner { env: Vec::new() },
            search_path: self.search_path.clone(),
        }
        .set(content, lease)
    }

    pub(crate) fn clear(&self, lease: &InteractionLease) -> Result<(), AdapterError> {
        Wayland {
            runner: &ProcessRunner { env: Vec::new() },
            search_path: self.search_path.clone(),
        }
        .clear(lease)
    }
}

#[cfg(test)]
#[path = "route_fallback_tests.rs"]
mod tests;
