use agent_desktop_core::{
    Action, ActionRequest, ActionResult, ActionStep, AdapterError, InteractionLease, MouseButton,
    Point, StepMechanism,
};

use crate::input::physical::target_pointer::click_shell;
use crate::system::SharedBus;
use crate::tree::AtspiElement;

fn button_of(action: &Action) -> Option<MouseButton> {
    match action {
        Action::Click => Some(MouseButton::Left),
        Action::RightClick => Some(MouseButton::Right),
        _ => None,
    }
}

/// Delivers a click on a shell control through the shell pointer path, which
/// every display backend supports, so a shell ref never meets the generic
/// pointer refusal of a backend that cannot aim at an ordinary window.
pub(crate) fn deliver(
    bus: &SharedBus,
    element: &AtspiElement,
    request: &ActionRequest,
    lease: &InteractionLease,
) -> Option<Result<ActionResult, AdapterError>> {
    deliver_with(&request.action, |button| {
        click_shell(bus, element, button, request.policy, lease)
    })
}

pub(super) fn deliver_with(
    action: &Action,
    click: impl FnOnce(MouseButton) -> Result<Point, AdapterError>,
) -> Option<Result<ActionResult, AdapterError>> {
    let button = button_of(action)?;
    Some(click(button).map(|_| {
        let step =
            ActionStep::succeeded("shell-pointer").with_mechanism(StepMechanism::PhysicalSynthetic);
        ActionResult::from_execution(action, vec![step])
    }))
}

#[cfg(test)]
#[path = "deliver_tests.rs"]
mod tests;
