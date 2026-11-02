use crate::ProcessId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub pid: ProcessId,
    pub instance: String,
}

impl ProcessIdentity {
    pub fn new(pid: impl Into<ProcessId>, instance: impl Into<String>) -> Self {
        Self {
            pid: pid.into(),
            instance: instance.into(),
        }
    }
}
