use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionStepOutcome {
    Attempted,
    Skipped,
    Succeeded,
}
