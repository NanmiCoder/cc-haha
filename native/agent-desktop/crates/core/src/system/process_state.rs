use serde::{Deserialize, Serialize};

/// Liveness/responsiveness classification for a target process.
///
/// macOS can only emit `Running`, `Exited { code: None }`, and
/// `Unresponsive` — it has no way to read the exit code of a detached
/// process (apps launched through NSWorkspace are not children of this
/// process). `Crashed` stays in the contract for adapters with real crash
/// evidence (e.g. Windows `GetExitCodeProcess`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ProcessState {
    Running,
    Exited {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
    },
    Crashed {
        signal_or_code: i32,
    },
    Unresponsive,
}

impl ProcessState {
    /// Compact lowercase tag for best-effort `details.process_state`
    /// enrichment on terminal errors — a short label, not the full
    /// serialized shape (which carries `code`/`signal_or_code` payloads).
    pub fn label(&self) -> &'static str {
        match self {
            ProcessState::Running => "running",
            ProcessState::Exited { .. } => "exited",
            ProcessState::Crashed { .. } => "crashed",
            ProcessState::Unresponsive => "unresponsive",
        }
    }
}

#[cfg(test)]
#[path = "process_state_tests.rs"]
mod tests;
