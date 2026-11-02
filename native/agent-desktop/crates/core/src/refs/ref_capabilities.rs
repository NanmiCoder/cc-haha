use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RefCapabilities {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<String>,
    pub available_actions: Vec<String>,
}
