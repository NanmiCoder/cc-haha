use serde::{Deserialize, Serialize};

use crate::ProcessId;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RefProcess {
    pub pid: ProcessId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_instance: Option<String>,
}
