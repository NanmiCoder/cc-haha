use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use serde_json::json;

use crate::input::deliver::ensure_budget;
use crate::input::physical::target_world::PhysicalWorld;

use crate::system::ACCESSIBLE_INTERFACE;
use crate::system::{SharedBus, within};
use crate::tree::call;
use crate::tree::properties::absence::gone_error;
use crate::tree::properties::liveness::Liveness;
use crate::tree::vocabulary::state_bits::{ACTIVE, StateBits};
use crate::tree::{AtspiElement, Field};

/// Reads the frame's own `ACTIVE` state. `None` means the state set could not
/// be read, which is not the same as the frame being inactive.
pub(crate) fn frame_active(
    bus: &SharedBus,
    frame: &AtspiElement,
    deadline: Deadline,
) -> Result<Option<bool>, AdapterError> {
    let shared = bus.get(deadline)?;
    within(deadline, async {
        let (role, states) = futures_util::future::join(
            call(shared.inner(), frame, ACCESSIBLE_INTERFACE, "GetRole", &()),
            call(shared.inner(), frame, ACCESSIBLE_INTERFACE, "GetState", &()),
        )
        .await;
        let role = role.and_then(|reply| reply.body().deserialize::<u32>());
        let liveness = Liveness::of(role.as_ref().err());
        for error in [role.as_ref().err(), states.as_ref().err()]
            .into_iter()
            .flatten()
        {
            if crate::system::is_connection_failure(error) {
                return Err(crate::system::classify(error));
            }
            if let Some(error) = gone_error(error, liveness) {
                return Err(error);
            }
        }
        if role.is_err() {
            return Ok(None);
        }
        Ok(states
            .ok()
            .and_then(|reply| reply.body().deserialize::<Vec<u32>>().ok())
            .and_then(|words| active_of(&Field::Present(words))))
    })
}

pub(crate) fn active_of(states: &Field<Vec<u32>>) -> Option<bool> {
    states
        .present()
        .map(|words| StateBits::new(words).has(ACTIVE))
}

const ACTIVE_BUDGET: Duration = Duration::from_millis(1500);
const ACTIVE_POLL: Duration = Duration::from_millis(50);

pub(crate) fn poll_active(
    world: &impl PhysicalWorld,
    element: &AtspiElement,
    budget: Duration,
    deadline: Deadline,
) -> Result<Option<bool>, AdapterError> {
    let reads = budget.as_millis() / ACTIVE_POLL.as_millis();
    let mut last = None;
    for attempt in 0..=reads {
        ensure_budget(deadline)?;
        last = world.frame_active(element, deadline)?;
        if last == Some(true) {
            break;
        }
        if attempt < reads {
            world.pause(ACTIVE_POLL);
        }
    }
    Ok(last)
}

/// The focus gate of one keyboard delivery. The first check waits for the
/// frame to become active and refuses the call before any key is sent; later
/// checks, made between chunks, read once and stop the delivery where it is.
pub(crate) struct ActiveGate<'a, W: PhysicalWorld> {
    world: &'a W,
    element: &'a AtspiElement,
    deadline: Deadline,
    checked: bool,
}

impl<'a, W: PhysicalWorld> ActiveGate<'a, W> {
    pub(crate) fn new(world: &'a W, element: &'a AtspiElement, deadline: Deadline) -> Self {
        Self {
            world,
            element,
            deadline,
            checked: false,
        }
    }

    pub(crate) fn check(&mut self) -> Result<(), AdapterError> {
        let first = !self.checked;
        self.checked = true;
        let budget = if first { ACTIVE_BUDGET } else { Duration::ZERO };
        match poll_active(self.world, self.element, budget, self.deadline)? {
            Some(true) => Ok(()),
            read if first => Err(window_inactive(read)),
            _ => Err(window_lost()),
        }
    }
}

fn window_inactive(read: Option<bool>) -> AdapterError {
    let cause = match read {
        Some(_) => "not_active",
        None => "unreadable",
    };
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The target window could not be confirmed active, so no key was sent",
    )
    .with_suggestion(
        "A pending system dialog can hold the keyboard; dismiss it, or focus the window, then retry",
    )
    .with_details(json!({
        "check": "window_active",
        "cause": cause,
        "physical_delivery_started": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn window_lost() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The target window could no longer be confirmed active while keys were being sent",
    )
    .with_suggestion("Focus the window again, then retry the remaining input")
    .with_details(json!({ "check": "window_active", "cause": "lost" }))
}

#[cfg(test)]
#[path = "frame_active_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "frame_active_live_tests.rs"]
mod live_tests;
