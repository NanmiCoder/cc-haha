use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatePredicate {
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<bool>,
}
