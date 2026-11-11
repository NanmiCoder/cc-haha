use crate::actions::action_step_outcome::ActionStepOutcome;
use crate::actions::step_mechanism::StepMechanism;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionStep {
    label: String,
    pub outcome: ActionStepOutcome,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mechanism: Option<StepMechanism>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub verified: Option<bool>,
}

impl ActionStep {
    pub fn attempted(label: &'static str) -> Self {
        Self {
            label: label.to_string(),
            outcome: ActionStepOutcome::Attempted,
            mechanism: None,
            verified: None,
        }
    }

    pub fn skipped(label: &'static str) -> Self {
        Self {
            label: label.to_string(),
            outcome: ActionStepOutcome::Skipped,
            mechanism: None,
            verified: None,
        }
    }

    pub fn succeeded(label: &'static str) -> Self {
        Self {
            label: label.to_string(),
            outcome: ActionStepOutcome::Succeeded,
            mechanism: None,
            verified: None,
        }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn mechanism(&self) -> Option<StepMechanism> {
        self.mechanism
    }

    pub fn verified(&self) -> Option<bool> {
        self.verified
    }

    pub fn with_mechanism(mut self, mechanism: StepMechanism) -> Self {
        self.mechanism = Some(mechanism);
        self
    }

    pub fn with_verified(mut self, verified: bool) -> Self {
        self.verified = Some(verified);
        self
    }
}

#[cfg(test)]
#[path = "action_step_tests.rs"]
mod tests;
