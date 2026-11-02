use crate::{
    Action, DeliverySemantics, actions::action_step::ActionStep,
    actions::action_step_outcome::ActionStepOutcome, tree::element_state::ElementState,
};
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_state: Option<ElementState>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub steps: Vec<ActionStep>,
    /// Overlays the application had open once the action settled. An action can
    /// leave a sheet, menu, or alert on screen, and without this the caller has
    /// to go hunting through windows to discover it.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub surfaces: Vec<crate::SurfaceInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(deserialize_with = "deserialize_action_disposition")]
    disposition: DeliverySemantics,
}

impl ActionResult {
    pub fn from_execution(action: &Action, steps: Vec<ActionStep>) -> Self {
        let label = action.name();
        let (delivered, verified) = delivery_summary(&steps);
        if !delivered {
            return Self::satisfied_without_delivery(label).with_steps(steps);
        }
        let mut result = Self::delivered_unverified(label).with_steps(steps);
        if verified {
            result = result.with_verified_delivery();
            if action.writes_element_value() {
                result = result.with_details(serde_json::json!({
                    "verification_scope": "element_value",
                    "application_commit": "not_verified",
                }));
            }
        }
        result
    }

    pub fn satisfied_without_delivery(action: impl Into<String>) -> Self {
        Self {
            action: action.into(),
            post_state: None,
            steps: Vec::new(),
            surfaces: Vec::new(),
            details: None,
            disposition: DeliverySemantics::not_delivered(),
        }
    }

    pub fn delivered_unverified(action: impl Into<String>) -> Self {
        Self {
            action: action.into(),
            post_state: None,
            steps: Vec::new(),
            surfaces: Vec::new(),
            details: None,
            disposition: default_action_disposition(),
        }
    }

    pub fn with_state(mut self, state: ElementState) -> Self {
        self.post_state = Some(state);
        self
    }

    pub fn with_steps(mut self, steps: Vec<ActionStep>) -> Self {
        self.steps = steps;
        self
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn with_verified_delivery(mut self) -> Self {
        if self.disposition == DeliverySemantics::delivered_unverified() {
            self.disposition = DeliverySemantics::delivered_verified();
        }
        self
    }

    pub(crate) fn with_unverified_delivery(mut self) -> Self {
        if self.disposition == DeliverySemantics::delivered_verified() {
            self.disposition = DeliverySemantics::delivered_unverified();
        }
        self
    }

    pub const fn disposition(&self) -> DeliverySemantics {
        self.disposition
    }
}

fn delivery_summary(steps: &[ActionStep]) -> (bool, bool) {
    let mut delivered = false;
    let mut verification = None;
    for step in steps {
        if matches!(step.outcome, ActionStepOutcome::Succeeded) {
            delivered = true;
            if let Some(verified) = step.verified() {
                verification = Some(verification.unwrap_or(true) && verified);
            }
        }
    }
    (delivered, verification.unwrap_or(false))
}

const fn default_action_disposition() -> DeliverySemantics {
    DeliverySemantics::delivered_unverified()
}

fn deserialize_action_disposition<'de, D>(deserializer: D) -> Result<DeliverySemantics, D::Error>
where
    D: Deserializer<'de>,
{
    let disposition = DeliverySemantics::deserialize(deserializer)?;
    match disposition {
        DeliverySemantics::NotDelivered
        | DeliverySemantics::DeliveredUnverified
        | DeliverySemantics::DeliveredVerified => Ok(disposition),
        _ => Err(serde::de::Error::custom(
            "successful action result must represent satisfied or delivered work",
        )),
    }
}

#[cfg(test)]
#[path = "action_result_tests.rs"]
mod tests;
