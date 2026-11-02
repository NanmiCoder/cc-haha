use agent_desktop_core::AdapterError;

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::actions::{
        chain::ChainDef, chain::ChainStep, chain::chain_disclosure_steps, chain::chain_menu_steps,
    };
    use crate::tree::AXElement;
    use agent_desktop_core::{ActionStep, Deadline, MouseButton, StepMechanism};

    static CLICK_CHAIN: ChainDef = ChainDef {
        steps: &[
            ChainStep::CGClick {
                button: MouseButton::Left,
                count: 1,
            },
            ChainStep::CustomWithDeadline {
                label: "AXPress",
                func: crate::actions::chain::press_selection::press_or_report_no_effect,
            },
            ChainStep::Action("AXOpen"),
            ChainStep::CustomWithDeadline {
                label: "activate_descendant",
                func: crate::actions::chain::activate_descendant::activate_descendant,
            },
            ChainStep::CustomWithDeadline {
                label: "select_within_container",
                func: crate::actions::select::container_select::select_within_container,
            },
            ChainStep::Action("AXConfirm"),
        ],
        suggestion: "Target an element that advertises Click or use an explicit point click.",
        continue_after_unverified_delivery: false,
    };

    static MENUBAR_CLICK_CHAIN: ChainDef = ChainDef {
        steps: &[ChainStep::Action("AXPress")],
        suggestion: "Refresh the menu-bar snapshot and target an item that supports AXPress.",
        continue_after_unverified_delivery: false,
    };

    pub(crate) fn click_chain(native_role: Option<&str>) -> &'static ChainDef {
        if native_role == Some("AXMenuBarItem") {
            &MENUBAR_CLICK_CHAIN
        } else {
            &CLICK_CHAIN
        }
    }

    /// Continues past an unverified delivery because an `AXShowMenu` that
    /// reports success without opening a menu must not consume the fallbacks
    /// behind it. Each step re-checks for an open menu first, so continuing
    /// cannot raise a second one.
    pub(crate) static RIGHT_CLICK_CHAIN: ChainDef = ChainDef {
        steps: &[
            ChainStep::CGClick {
                button: MouseButton::Right,
                count: 1,
            },
            ChainStep::CustomWithDeadline {
                label: "show_menu",
                func: chain_menu_steps::show_menu,
            },
            ChainStep::CustomWithDeadline {
                label: "select_then_show_menu",
                func: chain_menu_steps::select_then_show_menu,
            },
            ChainStep::CustomWithDeadline {
                label: "selected_items_menu",
                func: chain_menu_steps::select_then_selected_items_menu,
            },
            ChainStep::CustomWithDeadline {
                label: "child_show_menu",
                func: chain_menu_steps::show_menu_on_children,
            },
            ChainStep::CustomWithDeadline {
                label: "ancestor_show_menu",
                func: chain_menu_steps::show_menu_on_ancestors,
            },
        ],
        suggestion: "Try 'mouse-click --button right --xy X,Y'.",
        continue_after_unverified_delivery: true,
    };

    pub(crate) static EXPAND_CHAIN: ChainDef = ChainDef {
        steps: &[ChainStep::CustomWithDeadline {
            label: "expand_verified",
            func: chain_disclosure_steps::press_to_expand,
        }],
        suggestion: "Target a control with a readable expandable state.",
        continue_after_unverified_delivery: false,
    };

    pub(crate) static COLLAPSE_CHAIN: ChainDef = ChainDef {
        steps: &[ChainStep::CustomWithDeadline {
            label: "collapse_verified",
            func: chain_disclosure_steps::press_to_collapse,
        }],
        suggestion: "Target a control with a readable expandable state.",
        continue_after_unverified_delivery: false,
    };

    pub(crate) static SET_VALUE_CHAIN: ChainDef = ChainDef {
        steps: &[
            ChainStep::SetDynamic { attr: "AXValue" },
            ChainStep::IncrementToDynamic,
        ],
        suggestion: "Target an element with a settable value or native increment/decrement actions.",
        continue_after_unverified_delivery: false,
    };

    pub(crate) static CLEAR_CHAIN: ChainDef = ChainDef {
        steps: &[
            ChainStep::FocusThenClearByKeyboard,
            ChainStep::SetDynamic { attr: "AXValue" },
        ],
        suggestion: "Target an editable control or allow the verified keyboard fallback.",
        continue_after_unverified_delivery: false,
    };

    pub(crate) static SEMANTIC_CLICK_CHAIN: ChainDef = ChainDef {
        steps: &[
            ChainStep::Action("AXPress"),
            ChainStep::Action("AXOpen"),
            ChainStep::CustomWithDeadline {
                label: "activate_descendant",
                func: crate::actions::chain::activate_descendant::activate_descendant,
            },
            ChainStep::CustomWithDeadline {
                label: "select_within_container",
                func: crate::actions::select::container_select::select_within_container,
            },
            ChainStep::Action("AXConfirm"),
        ],
        suggestion: "Target an element that advertises Click.",
        continue_after_unverified_delivery: false,
    };

    pub(crate) static FOCUS_CHAIN: ChainDef = ChainDef {
        steps: &[ChainStep::SetBool {
            attr: "AXFocused",
            value: true,
        }],
        suggestion: "Target an element whose AXFocused attribute is settable.",
        continue_after_unverified_delivery: false,
    };

    pub(crate) static SCROLL_TO_CHAIN: ChainDef = ChainDef {
        steps: &[ChainStep::CustomWithDeadline {
            label: "scroll_to_visible_verified",
            func: crate::actions::scroll_into_view::scroll_into_view_outcome,
        }],
        suggestion: "Target an element that advertises AXScrollToVisible.",
        continue_after_unverified_delivery: false,
    };

    pub(crate) fn double_click(
        element: &AXElement,
        request: &agent_desktop_core::ActionRequest,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        physical_multi_click(element, 2, request, deadline)
    }

    pub(crate) fn triple_click(
        element: &AXElement,
        request: &agent_desktop_core::ActionRequest,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        physical_multi_click(element, 3, request, deadline)
    }

    fn physical_multi_click(
        element: &AXElement,
        count: u32,
        request: &agent_desktop_core::ActionRequest,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        crate::actions::physical_click::click_via_bounds(
            element,
            crate::actions::physical_click::PhysicalClick {
                button: MouseButton::Left,
                count,
                verified_point: request.verified_point().cloned(),
            },
            request.policy,
            deadline,
        )?;
        Ok(vec![
            ActionStep::succeeded("CGClick")
                .with_mechanism(StepMechanism::PhysicalSynthetic)
                .with_verified(false),
        ])
    }

    #[cfg(test)]
    mod tests {
        use super::{COLLAPSE_CHAIN, EXPAND_CHAIN};
        use crate::actions::chain::step_mechanism;
        use agent_desktop_core::StepMechanism;

        #[test]
        fn disclosure_chains_hold_only_semantic_steps_and_never_fall_back() {
            for chain in [&EXPAND_CHAIN, &COLLAPSE_CHAIN] {
                assert!(!chain.steps.is_empty());
                assert!(!chain.continue_after_unverified_delivery);
                for step in chain.steps {
                    assert_eq!(step_mechanism(step), StepMechanism::SemanticApi);
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {}

#[cfg(target_os = "macos")]
pub(crate) use imp::{
    CLEAR_CHAIN, COLLAPSE_CHAIN, EXPAND_CHAIN, FOCUS_CHAIN, RIGHT_CLICK_CHAIN, SCROLL_TO_CHAIN,
    SEMANTIC_CLICK_CHAIN, SET_VALUE_CHAIN, click_chain, double_click, triple_click,
};
