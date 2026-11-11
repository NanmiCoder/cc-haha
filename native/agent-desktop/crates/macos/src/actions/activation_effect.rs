#[cfg(target_os = "macos")]
mod imp {
    use agent_desktop_core::Deadline;

    use crate::tree::AXElement;

    const SETTLE_POLL_MS: u64 = 40;
    const SETTLE_BUDGET_MS: u64 = 400;
    const FOCUS_DESCENT_WALK: usize = 3;

    /// The readback for `perform`, which has no written attribute to re-read.
    /// Focus alone misses a whole family of controls: a sidebar row answers an
    /// unsupported code to the action that navigates it, and moves its
    /// selection rather than the focus. Selection is therefore read as well,
    /// on every element, because an attribute an element does not publish reads
    /// as absent and the rule simply never fires for it.
    #[derive(Default)]
    pub(crate) struct FocusState {
        focused_element: Option<AXElement>,
        selected: Option<bool>,
        menu_open: Option<bool>,
    }

    /// Accessibility hands back a fresh reference for the same element on every
    /// read, and reuses a released one for a different element later, so a raw
    /// pointer answers neither question this comparison asks. `CFEqual` is the
    /// identity the framework defines.
    impl PartialEq for FocusState {
        fn eq(&self, other: &Self) -> bool {
            match (&self.focused_element, &other.focused_element) {
                (None, None) => true,
                (Some(mine), Some(theirs)) => crate::tree::same_element(mine, theirs),
                _ => false,
            }
        }
    }

    impl FocusState {
        pub(crate) fn focused_element(self) -> Option<AXElement> {
            self.focused_element
        }
    }

    pub(crate) fn focus_state(element: &AXElement, deadline: Deadline) -> Option<FocusState> {
        let app = crate::system::app::app_ops::pid_from_element(element, deadline)
            .map(crate::tree::element_for_pid)?;
        Some(FocusState {
            focused_element: crate::tree::properties::attributes::copy_element_attr_result(
                &app,
                "AXFocusedUIElement",
                deadline,
            )
            .ok()?,
            selected: crate::tree::properties::attributes::copy_bool_attr_result(
                element,
                crate::actions::select::container_select::SELECTED,
                deadline,
            )
            .ok()
            .flatten(),
            menu_open: owned_menu_open(element, deadline),
        })
    }

    fn owned_menu_open(element: &AXElement, deadline: Deadline) -> Option<bool> {
        use crate::tree::surface_read;
        let end = crate::tree::locator_deadline::from_operation(deadline).ok()?;
        let role = surface_read::string(element, "AXRole", end).ok()??;
        if !matches!(
            role.as_str(),
            "AXMenuButton" | "AXPopUpButton" | "AXMenuBarItem" | "AXMenuItem"
        ) {
            return None;
        }
        let mut complete = true;
        for child in surface_read::elements(element, "AXChildren", end).ok()? {
            if surface_read::string(&child, "AXRole", end).ok()?? != "AXMenu" {
                continue;
            }
            let visible = surface_read::boolean(&child, "AXVisible", end).ok()?;
            let hidden = surface_read::boolean(&child, "AXHidden", end).ok()?;
            let bounds =
                crate::tree::element_bounds::read_bounds_with_deadline(&child, end).ok()?;
            match menu_visibility(visible, hidden, bounds) {
                Some(true) => return Some(true),
                Some(false) => {}
                None => complete = false,
            }
        }
        complete.then_some(false)
    }

    fn menu_visibility(
        visible: Option<bool>,
        hidden: Option<bool>,
        bounds: Option<agent_desktop_core::Rect>,
    ) -> Option<bool> {
        if visible == Some(false) || hidden == Some(true) {
            return Some(false);
        }
        let bounds = bounds?;
        if bounds.width <= 0.0 || bounds.height <= 0.0 {
            return Some(false);
        }
        (visible == Some(true) || hidden == Some(false)).then_some(true)
    }

    pub(crate) fn changed_now(
        before: &Option<FocusState>,
        element: &AXElement,
        deadline: Deadline,
    ) -> bool {
        let after = focus_state(element, deadline);
        let target_focused = after
            .as_ref()
            .and_then(|state| state.focused_element.as_ref())
            .is_some_and(|focused| focus_reached(focused, element, deadline));
        observed_change(before, &after, target_focused)
    }

    /// A control that owns an editor hands focus to the editor, not to itself:
    /// a PDF form field in Preview publishes a text area and focus lands there.
    /// Demanding an exact match called that a failure and reported an action
    /// that had plainly worked as one whose outcome was unknown.
    pub(crate) fn focus_reached(
        focused: &AXElement,
        element: &AXElement,
        deadline: Deadline,
    ) -> bool {
        let mut current = focused.clone();
        for _ in 0..FOCUS_DESCENT_WALK {
            if crate::tree::same_element(&current, element) {
                return true;
            }
            let Some(parent) = crate::tree::properties::attributes::copy_element_attr_result(
                &current, "AXParent", deadline,
            )
            .ok()
            .flatten() else {
                return false;
            };
            current = parent;
        }
        false
    }

    pub(crate) fn settled_change(
        before: &Option<FocusState>,
        element: &AXElement,
        deadline: Deadline,
    ) -> bool {
        if before.is_none() {
            return false;
        }
        let deadline = deadline.capped(std::time::Duration::from_millis(SETTLE_BUDGET_MS));
        while !deadline.is_expired() {
            if changed_now(before, element, deadline) {
                return true;
            }
            std::thread::sleep(
                deadline
                    .remaining()
                    .min(std::time::Duration::from_millis(SETTLE_POLL_MS)),
            );
        }
        false
    }

    fn observed_change(
        before: &Option<FocusState>,
        after: &Option<FocusState>,
        target_focused: bool,
    ) -> bool {
        let focus_moved_to_target = target_focused
            && matches!((before, after), (Some(before), Some(after)) if before != after);
        focus_moved_to_target
            || selection_turned_on(before, after)
            || matches!(
                (
                    before.as_ref().and_then(|state| state.menu_open),
                    after.as_ref().and_then(|state| state.menu_open),
                ),
                (Some(false), Some(true))
            )
    }

    /// An element that was not selected and now is has been acted on, whatever
    /// return code the application chose. The reverse is not evidence: a
    /// selection that was already true says nothing about this action.
    fn selection_turned_on(before: &Option<FocusState>, after: &Option<FocusState>) -> bool {
        matches!(
            (
                before.as_ref().and_then(|state| state.selected),
                after.as_ref().and_then(|state| state.selected),
            ),
            (Some(false), Some(true))
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn focused(pid: i32) -> Option<FocusState> {
            Some(FocusState {
                focused_element: Some(crate::tree::element_for_pid(pid)),
                selected: None,
                menu_open: None,
            })
        }

        fn selected(value: Option<bool>) -> Option<FocusState> {
            Some(FocusState {
                focused_element: None,
                selected: value,
                menu_open: None,
            })
        }

        #[test]
        fn focus_changes_must_correlate_with_the_target() {
            let before = focused(1);
            let after = focused(2);
            assert!(!observed_change(&before, &after, false));
            assert!(observed_change(&before, &after, true));
            assert!(!observed_change(&after, &after, true));
        }

        #[test]
        fn a_selection_that_turned_on_is_an_effect_without_any_focus_move() {
            assert!(observed_change(
                &selected(Some(false)),
                &selected(Some(true)),
                false
            ));
        }

        #[test]
        fn an_unchanged_or_unreadable_selection_proves_nothing() {
            for (before, after) in [
                (Some(true), Some(true)),
                (Some(false), Some(false)),
                (Some(true), Some(false)),
                (None, Some(true)),
                (Some(false), None),
                (None, None),
            ] {
                assert!(
                    !observed_change(&selected(before), &selected(after), false),
                    "before={before:?} after={after:?} must not count as an effect"
                );
            }
        }

        #[test]
        fn missing_observation_cannot_verify_an_action() {
            let before = Some(FocusState::default());
            let after = Some(FocusState::default());
            assert!(!observed_change(&before, &None, true));
            assert!(!observed_change(&None, &after, true));
            assert!(!observed_change(&None, &None, true));
            assert!(!observed_change(&before, &before, true));
            assert!(!observed_change(&before, &after, false));
            assert!(!observed_change(&before, &after, true));
        }

        #[test]
        fn only_a_newly_visible_owned_menu_verifies_delivery() {
            for before in [None, Some(false), Some(true)] {
                for after in [None, Some(false), Some(true)] {
                    let state = |menu_open| {
                        Some(FocusState {
                            menu_open,
                            ..FocusState::default()
                        })
                    };
                    assert_eq!(
                        observed_change(&state(before), &state(after), false),
                        before == Some(false) && after == Some(true),
                    );
                }
            }
        }

        #[test]
        fn menu_verification_requires_visible_nonempty_geometry() {
            let bounds = agent_desktop_core::Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            };
            assert_eq!(menu_visibility(None, Some(false), Some(bounds)), Some(true));
            assert_eq!(menu_visibility(Some(true), None, Some(bounds)), Some(true));
            assert_eq!(menu_visibility(None, None, Some(bounds)), None);
            assert_eq!(menu_visibility(Some(true), None, None), None);
            assert_eq!(
                menu_visibility(Some(false), Some(false), Some(bounds)),
                Some(false)
            );
            assert_eq!(
                menu_visibility(Some(true), Some(true), Some(bounds)),
                Some(false)
            );
            assert_eq!(
                menu_visibility(
                    Some(true),
                    Some(false),
                    Some(agent_desktop_core::Rect {
                        width: 0.0,
                        ..bounds
                    })
                ),
                Some(false)
            );
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use agent_desktop_core::Deadline;

    use crate::tree::AXElement;

    #[derive(Default, PartialEq)]
    pub(crate) struct FocusState;

    pub(crate) fn focus_state(_element: &AXElement, _deadline: Deadline) -> FocusState {
        FocusState
    }

    pub(crate) fn changed_now(
        _before: &FocusState,
        _element: &AXElement,
        _deadline: Deadline,
    ) -> bool {
        false
    }

    pub(crate) fn settled_change(
        _before: &FocusState,
        _element: &AXElement,
        _deadline: Deadline,
    ) -> bool {
        false
    }
}

#[cfg(target_os = "macos")]
pub(crate) use imp::focus_reached;
pub(crate) use imp::{changed_now, focus_state, settled_change};
