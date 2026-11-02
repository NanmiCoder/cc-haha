use crate::system::permission_state::PermissionState;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct PermissionReport {
    pub accessibility: PermissionState,
    pub screen_recording: PermissionState,
    pub automation: PermissionState,
}

impl PermissionReport {
    pub fn accessibility_granted(&self) -> bool {
        matches!(self.accessibility, PermissionState::Granted)
    }

    pub fn screen_recording_granted(&self) -> bool {
        matches!(self.screen_recording, PermissionState::Granted)
    }

    pub fn accessibility_denied(&self) -> bool {
        matches!(self.accessibility, PermissionState::Denied { .. })
    }

    pub fn screen_recording_denied(&self) -> bool {
        matches!(self.screen_recording, PermissionState::Denied { .. })
    }

    pub fn accessibility_suggestion(&self) -> Option<&str> {
        match &self.accessibility {
            PermissionState::Denied { suggestion } => Some(suggestion.as_str()),
            PermissionState::Granted | PermissionState::NotRequired | PermissionState::Unknown => {
                None
            }
        }
    }

    pub fn screen_recording_suggestion(&self) -> Option<&str> {
        match &self.screen_recording {
            PermissionState::Denied { suggestion } => Some(suggestion.as_str()),
            PermissionState::Granted | PermissionState::NotRequired | PermissionState::Unknown => {
                None
            }
        }
    }
}

impl Default for PermissionReport {
    fn default() -> Self {
        Self {
            accessibility: PermissionState::Unknown,
            screen_recording: PermissionState::Unknown,
            automation: PermissionState::NotRequired,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn permission_state_serializes_with_stable_state_field() {
        let report = PermissionReport {
            accessibility: PermissionState::Granted,
            screen_recording: PermissionState::Denied {
                suggestion: "grant screen recording".into(),
            },
            automation: PermissionState::NotRequired,
        };

        let value = serde_json::to_value(report).unwrap();

        assert_eq!(value["accessibility"], json!({"state": "granted"}));
        assert_eq!(
            value["screen_recording"],
            json!({"state": "denied", "suggestion": "grant screen recording"})
        );
        assert_eq!(value["automation"], json!({"state": "not_required"}));
    }
}
