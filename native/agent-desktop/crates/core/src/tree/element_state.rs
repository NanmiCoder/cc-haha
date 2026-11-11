use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElementState {
    pub role: String,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub states: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub offscreen: Option<bool>,
}

impl ElementState {
    /// The visibility the live state alone proves for a node whose bounds
    /// cannot be read: known on-screen and not hidden is visible, hidden is
    /// not, and anything else proves nothing. The actionability gate and the
    /// `is visible` command both answer from this one rule.
    pub(crate) fn visible_without_bounds(&self) -> Option<bool> {
        if self.offscreen != Some(false) {
            return None;
        }
        let hidden = self.hidden.unwrap_or_else(|| {
            crate::tree::state::has_state(&self.states, crate::tree::state::HIDDEN)
        });
        Some(!hidden)
    }
}
