use crate::Point;
use crate::actions::action::Action;
use crate::actions::interaction_policy::InteractionPolicy;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRequest {
    pub action: Action,
    pub policy: InteractionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip)]
    pub(crate) verified_point: Option<Point>,
    #[serde(skip)]
    pub(crate) expected_process: Option<crate::ProcessIdentity>,
}

impl ActionRequest {
    pub fn headed_requirement(&self) -> crate::HeadedRequirement {
        if self.policy.is_headed() {
            self.action.headed_requirement()
        } else {
            crate::HeadedRequirement::None
        }
    }

    pub fn headless(action: Action) -> Self {
        Self {
            action,
            policy: InteractionPolicy::headless(),
            timeout_ms: None,
            verified_point: None,
            expected_process: None,
        }
    }

    pub fn focus_fallback(action: Action) -> Self {
        Self {
            action,
            policy: InteractionPolicy::focus_fallback(),
            timeout_ms: None,
            verified_point: None,
            expected_process: None,
        }
    }

    pub fn headed(action: Action) -> Self {
        Self {
            action,
            policy: InteractionPolicy::headed(),
            timeout_ms: None,
            verified_point: None,
            expected_process: None,
        }
    }

    pub fn with_timeout_ms(mut self, timeout_ms: Option<u64>) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    pub(crate) fn with_verified_point(mut self, point: Option<Point>) -> Self {
        self.verified_point = point;
        self
    }

    pub fn with_expected_process(mut self, process: crate::ProcessIdentity) -> Self {
        self.expected_process = Some(process);
        self
    }

    pub fn verified_point(&self) -> Option<&Point> {
        self.verified_point.as_ref()
    }

    pub fn expected_process(&self) -> Option<&crate::ProcessIdentity> {
        self.expected_process.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Action, Direction};

    #[test]
    fn default_policy_is_headless() {
        let policy = InteractionPolicy::default();
        assert!(!policy.allow_focus_steal);
        assert!(!policy.allow_cursor_move);
    }

    #[test]
    fn headless_request_blocks_physical_side_effects() {
        let request = ActionRequest::headless(Action::Click);
        assert_eq!(request.policy, InteractionPolicy::headless());
    }

    #[test]
    fn headed_requirement_is_inert_until_the_caller_selects_headed_mode() {
        assert_eq!(
            ActionRequest::headless(Action::Click).headed_requirement(),
            crate::HeadedRequirement::None
        );
        assert_eq!(
            ActionRequest::headed(Action::Click).headed_requirement(),
            crate::HeadedRequirement::FocusedWindowAndCursor
        );
        assert_eq!(
            ActionRequest::headed(Action::TypeText("text".into())).headed_requirement(),
            crate::HeadedRequirement::FocusedWindow
        );
    }

    #[test]
    fn focus_fallback_policy_never_moves_cursor() {
        let request = ActionRequest::focus_fallback(Action::Scroll(Direction::Down, 1));
        assert!(request.policy.allow_focus_steal);
        assert!(!request.policy.allow_cursor_move);
    }

    /// Regression coverage: `ActionRequest.timeout_ms` must stay
    /// `#[serde(default)]` so a legacy payload recorded before `timeout_ms`
    /// existed (or any FFI/batch caller that omits the key) still
    /// deserializes instead of erroring out.
    #[test]
    fn action_request_json_without_timeout_ms_key_deserializes_to_none() {
        let request: ActionRequest = serde_json::from_value(serde_json::json!({
            "action": "Click",
            "policy": {
                "allow_focus_steal": false,
                "allow_cursor_move": false,
            },
        }))
        .unwrap();

        assert_eq!(request.timeout_ms, None);
    }

    #[test]
    fn positive_timeout_round_trips_through_the_wire_contract() {
        let request = ActionRequest::headless(Action::Click).with_timeout_ms(Some(5_000));
        let json = serde_json::to_value(&request).unwrap();

        assert_eq!(json["timeout_ms"], 5_000);
        let decoded: ActionRequest = serde_json::from_value(json).unwrap();
        assert_eq!(decoded.timeout_ms, Some(5_000));
    }

    #[test]
    fn execution_identity_is_runtime_only() {
        let request = ActionRequest::headless(Action::Click)
            .with_expected_process(crate::ProcessIdentity::new(42, "generation-1"));

        assert_eq!(
            request.expected_process(),
            Some(&crate::ProcessIdentity::new(42, "generation-1"))
        );
        let json = serde_json::to_value(request).unwrap();
        assert!(json.get("expected_process").is_none());
    }
}
