//! `execute_action` match over every `Action` variant.
//!
//! Click routes through the Invoke + Legacy chain. SetValue / Clear route
//! through `value_write`. Toggle / Check / Uncheck and Expand / Collapse route
//! through `toggle_state` and `disclosure`. Select and Scroll route through
//! their dedicated modules. SetFocus routes through `focus`.
//! ScrollTo runs the ScrollIntoView spine plus the ancestor ladder when
//! ScrollItem is absent or leaves geometry unchanged. Physical keyboard and
//! click legs route through `physical_keyboard` and `physical_click`.

use agent_desktop_core::{
    Action, ActionResult, ActionStep, AdapterError, Deadline, ErrorCode, InteractionLease,
    InteractionPolicy, NativeHandle, actions::action_request::ActionRequest,
};

/// Availability flags for the Click chain's two rungs, bundled so
/// `click_chain_judged_for` stays within the 5-parameter cap.
pub(crate) struct ClickAvailability {
    pub(crate) invoke_available: bool,
    pub(crate) legacy_available: bool,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        Action, ActionRequest, ActionResult, ActionStep, AdapterError, ClickAvailability, Deadline,
        ErrorCode, InteractionLease, InteractionPolicy, NativeHandle,
    };
    use crate::actions::chain::{
        CLICK_CHAIN, ChainRung, DeliveryOutcome, INVOKE_LABEL, build_step, execute_chain, gated,
        invoke_available, invoke_pattern_delivered,
    };
    use crate::actions::disclosure::{collapse_steps, expand_steps};
    use crate::actions::focus::focus_element;
    use crate::actions::mutation::{classify_success, classify_write};
    use crate::actions::physical_click::{
        double_click_steps, right_click_steps, triple_click_steps,
    };
    use crate::actions::physical_keyboard::{
        press_key_element_steps, press_key_global, type_text_steps,
    };
    use crate::actions::scroll::scroll_steps;
    use crate::actions::scroll_into_view::scroll_into_view_outcome;
    use crate::actions::select::select_steps;
    use crate::actions::toggle_state::{check_steps, toggle_steps, uncheck_steps};
    use crate::actions::value_write::{clear_steps, set_value_steps};
    use crate::tree::element::{UIAElement, uia_element};
    use crate::tree::live_read::corroborate_verified_process;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::read_one;
    use agent_desktop_core::LocatorField;
    use uiautomation::patterns::UILegacyIAccessiblePattern;

    const LEGACY_LABEL: &str = "LegacyIAccessible.DoDefaultAction";

    pub(crate) fn execute_action_impl(
        handle: &NativeHandle,
        request: ActionRequest,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        let deadline = lease.deadline();
        if handle.is_null() {
            return null_handle_action(&request.action, deadline);
        }
        let element = uia_element(handle)?;
        deadline.ensure_remaining()?;
        corroborate_verified_process(element)?;
        match &request.action {
            Action::Click => execute_click(element, request.policy, deadline),
            Action::SetFocus => focus_element(element, &request, deadline),
            Action::ScrollTo => execute_scroll_to(handle, lease),
            Action::TypeText(text) => {
                let steps = type_text_steps(element, text, request.policy, deadline)?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::PressKey(combo) => {
                let steps = press_key_element_steps(element, combo, request.policy, deadline)?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::DoubleClick => {
                let steps = double_click_steps(
                    element,
                    request.policy,
                    deadline,
                    request.verified_point().cloned(),
                )?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::TripleClick => {
                let steps = triple_click_steps(
                    element,
                    request.policy,
                    deadline,
                    request.verified_point().cloned(),
                )?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::RightClick => {
                let steps = right_click_steps(
                    element,
                    request.policy,
                    deadline,
                    request.verified_point().cloned(),
                )?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::KeyDown(_) | Action::KeyUp(_) | Action::Hover | Action::Drag(_) => {
                adapter_level_rejection(request.action.name())
            }
            Action::SetValue(value) => {
                let steps = set_value_steps(element, value, request.policy, deadline)?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::Clear => {
                let steps = clear_steps(element, request.policy, deadline)?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::Toggle => {
                let steps = toggle_steps(element, request.policy, deadline)?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::Check => {
                let steps = check_steps(element, request.policy, deadline)?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::Uncheck => {
                let steps = uncheck_steps(element, request.policy, deadline)?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::Expand => {
                let steps = expand_steps(element, request.policy, deadline)?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::Collapse => {
                let steps = collapse_steps(element, request.policy, deadline)?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::Select(value) => {
                let steps = select_steps(element, value, deadline)?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
            Action::Scroll(direction, amount) => {
                let steps = scroll_steps(element, direction, *amount, deadline)?;
                Ok(ActionResult::from_execution(&request.action, steps))
            }
        }
    }

    fn null_handle_action(
        action: &Action,
        deadline: Deadline,
    ) -> Result<ActionResult, AdapterError> {
        match action {
            Action::PressKey(combo) => press_key_global(combo, deadline),
            _ => Err(invalid_native_handle(true)),
        }
    }

    fn invalid_native_handle(empty: bool) -> AdapterError {
        AdapterError::new(
            ErrorCode::InvalidArgs,
            "Native handle does not contain a Windows UI Automation element",
        )
        .with_details(serde_json::json!({
            "kind": "invalid_native_handle",
            "platform": "windows",
            "empty": empty
        }))
    }

    fn adapter_level_rejection(label: &str) -> Result<ActionResult, AdapterError> {
        Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            format!("{label} requires adapter-level handling, not element action"),
        )
        .with_suggestion(
            "Use the top-level command (e.g. 'hover', 'drag', 'press') instead of targeting an element.",
        ))
    }

    fn execute_scroll_to(
        handle: &NativeHandle,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        let done = scroll_into_view_outcome(handle, lease)?;
        Ok(ActionResult::from_execution(
            &Action::ScrollTo,
            vec![build_step(done.label, done.outcome)],
        ))
    }

    fn execute_click(
        element: &UIAElement,
        policy: InteractionPolicy,
        deadline: Deadline,
    ) -> Result<ActionResult, AdapterError> {
        let steps = click_chain_judged_for(
            deadline,
            policy,
            ClickAvailability {
                invoke_available: invoke_available(element),
                legacy_available: click_legacy_available(element),
            },
            || {
                Ok(DeliveryOutcome::from_delivery(
                    invoke_pattern_delivered(element)?,
                    false,
                ))
            },
            || legacy_default_action(element),
        )?;
        Ok(ActionResult::from_execution(&Action::Click, steps))
    }

    pub(crate) fn click_legacy_available(element: &UIAElement) -> bool {
        matches!(
            read_one(element, TreeProperty::LegacyDefaultAction).text(),
            LocatorField::Known(text) if !text.trim().is_empty()
        )
    }

    /// Click chain with injected rungs — unit-test seam and live path.
    pub(crate) fn click_chain_judged_for(
        deadline: Deadline,
        policy: InteractionPolicy,
        availability: ClickAvailability,
        mut invoke: impl FnMut() -> Result<DeliveryOutcome, AdapterError>,
        mut legacy: impl FnMut() -> Result<DeliveryOutcome, AdapterError>,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let mut invoke_run = gated(availability.invoke_available, &mut invoke);
        let mut legacy_run = gated(availability.legacy_available, &mut legacy);
        execute_chain(
            deadline,
            &CLICK_CHAIN,
            policy,
            &mut [
                ChainRung {
                    label: INVOKE_LABEL,
                    requires_headed: false,
                    run: &mut invoke_run,
                },
                ChainRung {
                    label: LEGACY_LABEL,
                    requires_headed: false,
                    run: &mut legacy_run,
                },
            ],
        )
    }

    fn legacy_default_action(element: &UIAElement) -> Result<DeliveryOutcome, AdapterError> {
        let delivered = match element.0.get_pattern::<UILegacyIAccessiblePattern>() {
            Ok(pattern) => match pattern.do_default_action() {
                Ok(()) => classify_success()?,
                Err(error) => classify_write("DoDefaultAction", LEGACY_LABEL, &error)?,
            },
            Err(error) => classify_write("get_pattern", LEGACY_LABEL, &error)?,
        };
        Ok(DeliveryOutcome::from_delivery(delivered, false))
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{ActionRequest, ActionResult, AdapterError, InteractionLease, NativeHandle};

    pub(crate) fn execute_action_impl(
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Err(AdapterError::not_supported("execute_action"))
    }
}

pub(crate) use imp::execute_action_impl;

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::click_chain_judged_for;

#[cfg(all(test, target_os = "windows"))]
#[path = "dispatch_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "dispatch_r2_tests.rs"]
mod r2_tests;
