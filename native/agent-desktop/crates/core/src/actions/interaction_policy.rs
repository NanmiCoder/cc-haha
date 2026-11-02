use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractionPolicy {
    pub allow_focus_steal: bool,
    pub allow_cursor_move: bool,
}

impl InteractionPolicy {
    pub fn headless() -> Self {
        Self {
            allow_focus_steal: false,
            allow_cursor_move: false,
        }
    }

    pub fn focus_fallback() -> Self {
        Self {
            allow_focus_steal: true,
            allow_cursor_move: false,
        }
    }

    pub fn headed() -> Self {
        Self {
            allow_focus_steal: true,
            allow_cursor_move: true,
        }
    }

    pub fn is_headed(self) -> bool {
        self.allow_focus_steal && self.allow_cursor_move
    }

    pub fn join(self, other: InteractionPolicy) -> InteractionPolicy {
        InteractionPolicy {
            allow_focus_steal: self.allow_focus_steal || other.allow_focus_steal,
            allow_cursor_move: self.allow_cursor_move || other.allow_cursor_move,
        }
    }
}

impl Default for InteractionPolicy {
    fn default() -> Self {
        Self::headless()
    }
}

#[cfg(test)]
#[path = "interaction_policy_tests.rs"]
mod tests;
