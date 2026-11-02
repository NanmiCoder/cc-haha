use agent_desktop_core::{
    Action, ActionResult, ActionStep, AdapterError, Deadline, ErrorCode, StepMechanism,
    actions::action_request::ActionRequest,
};

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::actions::{
        chain::chain_defs,
        chain::{ChainContext, ChainDef, execute_chain},
        toggle_state,
    };
    use crate::tree::AXElement;

    pub(crate) fn perform_action(
        el: &AXElement,
        request: &ActionRequest,
        deadline: Deadline,
    ) -> Result<ActionResult, AdapterError> {
        let budget = ChainContext {
            dynamic_value: None,
            verified_point: request.verified_point(),
            deadline,
        };
        crate::tree::properties::attributes::set_messaging_timeout(el, deadline)?;
        budget.ensure_budget()?;
        let action = &request.action;
        let label = action.name();
        let mut steps = Vec::new();
        tracing::debug!("action: perform {label}");
        match action {
            Action::Click => {
                let role = if request.policy.is_headed() {
                    probe_click_role(el, deadline)?
                } else {
                    None
                };
                steps.extend(run_chain(
                    el,
                    chain_defs::click_chain(role.as_deref()),
                    None,
                    request,
                    deadline,
                )?);
            }

            Action::DoubleClick => {
                steps.extend(chain_defs::double_click(el, request, deadline)?);
            }

            Action::RightClick => {
                steps.extend(run_chain(
                    el,
                    &chain_defs::RIGHT_CLICK_CHAIN,
                    None,
                    request,
                    deadline,
                )?);
            }

            Action::Toggle => {
                steps.extend(toggle_state::toggle(el, request.policy, deadline)?);
            }

            Action::SetValue(val) => {
                steps.extend(run_chain(
                    el,
                    &chain_defs::SET_VALUE_CHAIN,
                    Some(val),
                    request,
                    deadline,
                )?);
            }

            Action::SetFocus => {
                steps.extend(run_chain(
                    el,
                    &chain_defs::FOCUS_CHAIN,
                    None,
                    request,
                    deadline,
                )?);
            }

            Action::TypeText(text) => {
                steps.push(crate::actions::type_text::execute_type(
                    el,
                    text.as_str(),
                    request.policy,
                    deadline,
                )?);
            }

            Action::PressKey(combo) => {
                crate::actions::physical_keyboard::press(el, combo, request.policy, deadline)?;
                steps.push(
                    ActionStep::succeeded("PressKey")
                        .with_mechanism(StepMechanism::PhysicalSynthetic)
                        .with_verified(false),
                );
            }

            Action::Expand => {
                steps.extend(run_chain(
                    el,
                    &chain_defs::EXPAND_CHAIN,
                    None,
                    request,
                    deadline,
                )?);
            }

            Action::Collapse => {
                steps.extend(run_chain(
                    el,
                    &chain_defs::COLLAPSE_CHAIN,
                    None,
                    request,
                    deadline,
                )?);
            }

            Action::Select(value) => {
                let verified = crate::actions::extras::select_value(el, value.as_str(), deadline)?;
                steps.push(
                    ActionStep::succeeded("Select")
                        .with_mechanism(StepMechanism::SemanticApi)
                        .with_verified(verified),
                );
            }

            Action::Scroll(direction, amount) => {
                let (mechanism, verified) = crate::actions::scroll::ax_scroll(
                    el,
                    direction,
                    *amount,
                    request.policy,
                    deadline,
                )?;
                steps.push(
                    ActionStep::succeeded("Scroll")
                        .with_mechanism(mechanism)
                        .with_verified(verified),
                );
            }

            Action::Check => {
                steps.extend(toggle_state::check_uncheck(
                    el,
                    true,
                    request.policy,
                    deadline,
                )?);
            }

            Action::Uncheck => {
                steps.extend(toggle_state::check_uncheck(
                    el,
                    false,
                    request.policy,
                    deadline,
                )?);
            }

            Action::TripleClick => {
                steps.extend(chain_defs::triple_click(el, request, deadline)?);
            }

            Action::ScrollTo => {
                steps.extend(run_chain(
                    el,
                    &chain_defs::SCROLL_TO_CHAIN,
                    None,
                    request,
                    deadline,
                )?);
            }

            Action::Clear => {
                steps.extend(run_chain(
                    el,
                    &chain_defs::CLEAR_CHAIN,
                    Some(""),
                    request,
                    deadline,
                )?);
            }

            Action::KeyDown(_) | Action::KeyUp(_) | Action::Hover | Action::Drag(_) => {
                return Err(AdapterError::new(
                    ErrorCode::ActionNotSupported,
                    format!(
                        "{} requires adapter-level handling, not element action",
                        label
                    ),
                )
                .with_suggestion("Use the top-level command (e.g. 'hover', 'drag', 'press') instead of targeting an element."));
            }
        }

        Ok(ActionResult::from_execution(action, steps))
    }

    fn run_chain(
        element: &AXElement,
        definition: &ChainDef,
        dynamic_value: Option<&str>,
        request: &ActionRequest,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        execute_chain(
            element,
            definition,
            &ChainContext {
                dynamic_value,
                verified_point: request.verified_point(),
                deadline,
            },
            request.policy,
        )
    }

    fn probe_click_role(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<Option<String>, AdapterError> {
        let operation_deadline = crate::tree::locator_deadline::from_operation(deadline)?;
        match crate::tree::resolve::resolve_ax_read::read_string(
            element,
            "AXRole",
            operation_deadline,
        ) {
            Err(error) if error.code == ErrorCode::AppUnresponsive => Ok(None),
            result => result,
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;
    use crate::tree::AXElement;

    pub fn perform_action(
        _el: &AXElement,
        _request: &ActionRequest,
        _deadline: Deadline,
    ) -> Result<ActionResult, AdapterError> {
        Err(AdapterError::not_supported("perform_action"))
    }
}

pub(crate) use imp::perform_action;
