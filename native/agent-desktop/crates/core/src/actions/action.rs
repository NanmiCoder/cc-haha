use serde::{Deserialize, Serialize};

use crate::{Direction, DragParams, KeyCombo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Action {
    Click,
    DoubleClick,
    RightClick,
    TripleClick,
    SetValue(String),
    SetFocus,
    Expand,
    Collapse,
    Select(String),
    Toggle,
    Check,
    Uncheck,
    Scroll(Direction, u32),
    ScrollTo,
    PressKey(KeyCombo),
    KeyDown(KeyCombo),
    KeyUp(KeyCombo),
    TypeText(String),
    Clear,
    Hover,
    Drag(DragParams),
}

impl Action {
    pub fn headed_requirement(&self) -> crate::HeadedRequirement {
        match self {
            Self::Click
            | Self::DoubleClick
            | Self::RightClick
            | Self::TripleClick
            | Self::Scroll(_, _)
            | Self::Hover
            | Self::Drag(_) => crate::HeadedRequirement::FocusedWindowAndCursor,
            Self::SetValue(_)
            | Self::SetFocus
            | Self::Expand
            | Self::Collapse
            | Self::Select(_)
            | Self::Toggle
            | Self::Check
            | Self::Uncheck
            | Self::ScrollTo
            | Self::PressKey(_)
            | Self::KeyDown(_)
            | Self::KeyUp(_)
            | Self::TypeText(_)
            | Self::Clear => crate::HeadedRequirement::FocusedWindow,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Click => "click",
            Self::DoubleClick => "double-click",
            Self::RightClick => "right-click",
            Self::TripleClick => "triple-click",
            Self::SetValue(_) => "set-value",
            Self::SetFocus => "focus",
            Self::Expand => "expand",
            Self::Collapse => "collapse",
            Self::Select(_) => "select",
            Self::Toggle => "toggle",
            Self::Check => "check",
            Self::Uncheck => "uncheck",
            Self::Scroll(_, _) => "scroll",
            Self::ScrollTo => "scroll-to",
            Self::PressKey(_) => "press",
            Self::KeyDown(_) => "key-down",
            Self::KeyUp(_) => "key-up",
            Self::TypeText(_) => "type",
            Self::Clear => "clear",
            Self::Hover => "hover",
            Self::Drag(_) => "drag",
        }
    }

    pub(crate) fn writes_element_value(&self) -> bool {
        matches!(self, Self::SetValue(_) | Self::Clear | Self::TypeText(_))
    }

    pub(crate) fn requires_state_readback(&self) -> bool {
        self.writes_element_value()
            || matches!(
                self,
                Self::Check | Self::Uncheck | Self::Toggle | Self::Expand | Self::Collapse
            )
    }

    pub fn requires_cursor_policy(&self) -> bool {
        matches!(self, Self::Hover | Self::Drag(_))
    }

    pub fn requires_hit_test(&self) -> bool {
        matches!(
            self,
            Self::Click
                | Self::DoubleClick
                | Self::RightClick
                | Self::TripleClick
                | Self::Hover
                | Self::Drag(_)
        )
    }

    /// Whether the action is delivered as keyboard input. Such an action never
    /// aims a pointer, so it needs no element geometry and no window
    /// activation on a session whose keys reach the focused element.
    pub(crate) fn delivered_by_keyboard(&self) -> bool {
        matches!(
            self,
            Self::TypeText(_) | Self::PressKey(_) | Self::KeyDown(_) | Self::KeyUp(_)
        )
    }

    /// Whether the action can leave the application showing a sheet, menu, or
    /// alert. Listing surfaces costs a walk of the application's overlays, so
    /// only the actions that can raise one pay for it.
    pub fn may_raise_surface(&self) -> bool {
        matches!(
            self,
            Self::Click
                | Self::DoubleClick
                | Self::RightClick
                | Self::TripleClick
                | Self::Expand
                | Self::Select(_)
                | Self::PressKey(_)
        )
    }

    pub fn requires_scroll_into_view(&self) -> bool {
        matches!(
            self,
            Self::Click
                | Self::DoubleClick
                | Self::RightClick
                | Self::TripleClick
                | Self::SetValue(_)
                | Self::Expand
                | Self::Collapse
                | Self::Select(_)
                | Self::Toggle
                | Self::Check
                | Self::Uncheck
                | Self::TypeText(_)
                | Self::Clear
                | Self::Hover
                | Self::Drag(_)
                | Self::Scroll(_, _)
        )
    }

    pub fn may_use_focus_fallback(&self) -> bool {
        matches!(self, Self::TypeText(_) | Self::PressKey(_))
    }

    /// Returns the command's minimum interaction policy.
    pub fn base_interaction_policy(&self) -> crate::actions::interaction_policy::InteractionPolicy {
        if matches!(self, Self::PressKey(_)) {
            crate::actions::interaction_policy::InteractionPolicy::focus_fallback()
        } else {
            crate::actions::interaction_policy::InteractionPolicy::headless()
        }
    }
}

#[cfg(test)]
#[path = "action_tests.rs"]
mod tests;
