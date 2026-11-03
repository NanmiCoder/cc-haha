use agent_desktop_core::{
    Action, ActionRequest, ActionResult, AdapterError, Deadline, DeliverySemantics, ErrorCode,
    InteractionLease,
};
use serde_json::json;

use crate::input::deliver::ensure_budget;
use crate::input::physical::target_keyboard;
use crate::input::physical::target_pointer::{self, ClickSpec};
use crate::input::physical::target_world::LiveWorld;
use crate::input::physical::target_world::PhysicalWorld;
use crate::system::SharedBus;
use crate::tree::AtspiElement;

pub(crate) fn deliver(
    bus: &SharedBus,
    action: &Action,
    element: Option<&AtspiElement>,
    request: &ActionRequest,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    deliver_in(
        &LiveWorld { bus, lease },
        action,
        element,
        request,
        lease.deadline(),
    )
}

pub(crate) fn deliver_in(
    world: &impl PhysicalWorld,
    action: &Action,
    element: Option<&AtspiElement>,
    request: &ActionRequest,
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    ensure_budget(deadline)?;
    let verified = request.verified_point().cloned();
    let steps = match (action, element) {
        (Action::PressKey(combo), None) => {
            target_keyboard::press_key_global_steps(world, combo, deadline)?
        }
        (Action::KeyDown(_) | Action::KeyUp(_) | Action::Hover | Action::Drag(_), _) => {
            return Err(adapter_level_rejection(action.name()));
        }
        (_, None) => return Err(missing_element(action.name())),
        (Action::TypeText(_) | Action::PressKey(_), Some(target)) => {
            target_keyboard::target_steps(world, target, action, request.policy, deadline)?
        }
        (Action::Click, Some(target)) => target_pointer::click_steps(
            world,
            target,
            ClickSpec::left(1, verified),
            request.policy,
            deadline,
        )?,
        (Action::DoubleClick, Some(target)) => target_pointer::click_steps(
            world,
            target,
            ClickSpec::left(2, verified),
            request.policy,
            deadline,
        )?,
        (Action::TripleClick, Some(target)) => target_pointer::click_steps(
            world,
            target,
            ClickSpec::left(3, verified),
            request.policy,
            deadline,
        )?,
        (Action::RightClick, Some(target)) => target_pointer::click_steps(
            world,
            target,
            ClickSpec::right(verified),
            request.policy,
            deadline,
        )?,
        (Action::Scroll(direction, amount), Some(target)) => target_pointer::scroll_steps(
            world,
            target,
            target_pointer::wheel_deltas(direction, *amount),
            request.policy,
            deadline,
        )?,
        (other, Some(_)) => return Err(unsupported_action(other.name())),
    };
    Ok(ActionResult::from_execution(action, steps))
}

fn adapter_level_rejection(label: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("{label} requires adapter-level handling, not element action"),
    )
    .with_suggestion(
        "Use the top-level command (e.g. 'hover', 'drag', 'press') instead of targeting an element.",
    )
    .with_details(json!({ "physical_delivery_started": false }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn unsupported_action(label: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("{label} has no physical delivery on Linux"),
    )
    .with_details(json!({ "physical_delivery_started": false }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn missing_element(label: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::InvalidArgs,
        format!("{label} needs a target element for physical delivery"),
    )
    .with_details(json!({ "physical_delivery_started": false }))
    .with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(test)]
#[path = "physical_target_tests.rs"]
pub(crate) mod tests;
