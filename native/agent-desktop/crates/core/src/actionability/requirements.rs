use super::PointerDelivery;
use crate::actions::action::Action;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ActionabilityRequirements {
    pub(crate) visible: bool,
    pub(crate) stable: bool,
    pub(crate) enabled: bool,
    pub(crate) editable: bool,
    pub(crate) receives_events: bool,
}

impl ActionabilityRequirements {
    pub(crate) fn for_action(action: &Action) -> Self {
        match action {
            Action::Click | Action::DoubleClick | Action::RightClick | Action::TripleClick => {
                Self::new(true, true, true, false, true)
            }
            Action::Hover | Action::Drag(_) => Self::new(true, true, false, false, true),
            Action::SetValue(_) | Action::TypeText(_) | Action::Clear => {
                Self::new(true, false, true, true, false)
            }
            Action::Select(_) => Self::new(true, false, true, false, false),
            Action::Expand
            | Action::Collapse
            | Action::Toggle
            | Action::Check
            | Action::Uncheck
            | Action::Scroll(_, _) => Self::new(true, true, true, false, false),
            Action::ScrollTo => Self::new(false, true, false, false, false),
            Action::SetFocus | Action::PressKey(_) | Action::KeyDown(_) | Action::KeyUp(_) => {
                Self::new(false, false, false, false, false)
            }
        }
    }

    pub(crate) fn pointer_delivery(
        &self,
        action: &Action,
        available_actions: &[String],
        policy: crate::InteractionPolicy,
    ) -> PointerDelivery {
        if !self.receives_events {
            return PointerDelivery::NotApplicable;
        }
        if policy.is_headed() && action.headed_requirement().requires_cursor() {
            PointerDelivery::Physical
        } else if crate::actions::capability::supports_direct_semantic_pointer_delivery(
            action,
            available_actions,
        ) {
            PointerDelivery::Semantic
        } else {
            PointerDelivery::Physical
        }
    }

    /// Whether visibility must be proven from pointer bounds. Strictly headless
    /// semantic delivery (AXPress/AXShowMenu, or an advertised editable-text
    /// capability) does not use a pointer, so closed-menu items and editors
    /// without usable bounds stay actionable. The visibility gate applies this
    /// only to targets that report bounds but no owning window (`offscreen`
    /// unknown), the shape macOS closed-menu items have: a zero-size control
    /// inside a known window still needs bounds. A separately proven nonspatial
    /// protocol target needs complete live state instead of geometry. Explicit
    /// hidden/offscreen state still gates both. Headed pointer
    /// paths keep the geometry requirement, but an action typed through the
    /// keyboard never uses a pointer: a Wayland field reports no bounds, and
    /// waiting for one that can never arrive spends the whole budget on a
    /// check the session cannot answer.
    pub(crate) fn requires_geometry(
        &self,
        request: &crate::ActionRequest,
        available_actions: &[String],
    ) -> bool {
        if request.action.delivered_by_keyboard() {
            return false;
        }
        if request.policy != crate::InteractionPolicy::headless() {
            return true;
        }
        let direct_pointer = crate::actions::capability::supports_direct_semantic_pointer_delivery(
            &request.action,
            available_actions,
        );
        let direct_text = self.editable
            && crate::actions::capability::contains_any(
                available_actions,
                crate::actions::capability::for_action(&request.action),
            );
        !(direct_pointer || direct_text)
    }

    /// Whether a headless action reaches its target without a pointer: the
    /// delivery is semantic (a click through an advertised verb) or the
    /// action's own capability is advertised, and no cursor or hit test is
    /// involved. Headed, hover, drag and a click with no semantic verb are
    /// pointer-delivered and never qualify.
    pub(crate) fn delivered_without_pointer(
        &self,
        request: &crate::ActionRequest,
        available_actions: &[String],
        pointer_delivery: PointerDelivery,
    ) -> bool {
        if request.policy != crate::InteractionPolicy::headless() {
            return false;
        }
        match pointer_delivery {
            PointerDelivery::Physical => false,
            PointerDelivery::Semantic => true,
            PointerDelivery::NotApplicable => crate::actions::capability::contains_any(
                available_actions,
                crate::actions::capability::for_action(&request.action),
            ),
        }
    }

    pub(crate) fn requires_stability(&self, pointer_delivery: PointerDelivery) -> bool {
        self.stable && !matches!(pointer_delivery, PointerDelivery::Semantic)
    }

    const fn new(
        visible: bool,
        stable: bool,
        enabled: bool,
        editable: bool,
        receives_events: bool,
    ) -> Self {
        Self {
            visible,
            stable,
            enabled,
            editable,
            receives_events,
        }
    }
}

#[cfg(test)]
#[path = "requirements_tests.rs"]
mod tests;
