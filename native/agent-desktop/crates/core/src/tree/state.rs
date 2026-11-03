use crate::Rect;

pub const FOCUSED: &str = "focused";
pub const DISABLED: &str = "disabled";
pub const SECURE: &str = "secure";
pub const EXPANDED: &str = "expanded";
pub const CHECKED: &str = "checked";
pub const SELECTED: &str = "selected";
pub const HIDDEN: &str = "hidden";
pub const BUSY: &str = "busy";
pub const MODAL: &str = "modal";
pub const REQUIRED: &str = "required";
pub const INDETERMINATE: &str = "indeterminate";
pub const PRESSED: &str = "pressed";
pub const READONLY: &str = "readonly";
pub const OFFSCREEN: &str = "offscreen";
/// Vocabulary member with no macOS AX producer today (per the producer
/// survey: no AX attribute maps cleanly to element-level validity). Reserved
/// for adapters/platforms that can emit it; `assert_states_in_vocabulary`
/// still accepts it so cross-platform consumers do not have to special-case
/// macOS.
pub const INVALID: &str = "invalid";
/// Vocabulary member with no macOS AX producer today (per the producer
/// survey: AX exposes selection on the selectable child, not a
/// multi-select flag on the container). Reserved for adapters/platforms
/// that can emit it.
pub const MULTISELECTABLE: &str = "multiselectable";
/// Vocabulary member with no macOS AX producer today (per the producer
/// survey: no direct AX attribute for "has a popup"). Reserved for
/// adapters/platforms that can emit it.
pub const HASPOPUP: &str = "haspopup";

pub const STATE_VOCABULARY: &[&str] = &[
    FOCUSED,
    DISABLED,
    SECURE,
    EXPANDED,
    CHECKED,
    SELECTED,
    HIDDEN,
    BUSY,
    MODAL,
    REQUIRED,
    INDETERMINATE,
    PRESSED,
    READONLY,
    OFFSCREEN,
    INVALID,
    MULTISELECTABLE,
    HASPOPUP,
];

pub fn has_state(states: &[String], token: &str) -> bool {
    states.iter().any(|state| state == token)
}

pub fn assert_states_in_vocabulary(states: &[String]) {
    for state in states {
        assert!(
            STATE_VOCABULARY.contains(&state.as_str()),
            "state token '{state}' is not in STATE_VOCABULARY"
        );
    }
}

pub fn is_visible(bounds: Option<Rect>, states: &[String]) -> bool {
    crate::actionability::bounds_are_visible(bounds)
        && !has_state(states, HIDDEN)
        && !has_state(states, OFFSCREEN)
}

pub struct VisibilityEvidence {
    pub bounds: Option<Rect>,
    pub states: Vec<String>,
    pub bounds_from_live: bool,
    pub states_from_live: bool,
}

impl VisibilityEvidence {
    pub fn applicable(&self) -> bool {
        self.bounds_from_live && self.states_from_live
    }

    pub fn result(&self) -> bool {
        if !self.applicable() {
            return false;
        }
        is_visible(self.bounds, &self.states)
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
