use agent_desktop_core::{ActionResult, AdapterError, Deadline, InteractionLease, NativeHandle};

use crate::actions::chain::chain_def::ChainDef;
use crate::actions::chain::chain_delivery_outcome::DeliveryOutcome;
use crate::actions::chain::chain_observed::Observed;
use crate::actions::chain::chain_rung::Rung;
use crate::actions::chain::execute_chain;
use crate::system::SharedBus;
use crate::tree::get_live_state;

const SCROLL_LABEL: &str = "Component.ScrollTo";
const SUGGESTION: &str =
    "Refresh the snapshot and check whether the element is on screen before deciding to retry.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Visibility {
    OnScreen,
    OffScreen,
    Unread,
}

pub(crate) trait ScrollPort {
    fn visibility(&mut self) -> Visibility;
    fn scroll(&mut self) -> Result<bool, AdapterError>;
}

struct BusPort<'a> {
    bus: &'a SharedBus,
    handle: &'a NativeHandle,
    lease: &'a InteractionLease,
}

impl ScrollPort for BusPort<'_> {
    fn visibility(&mut self) -> Visibility {
        match get_live_state(self.bus, self.handle, self.lease.deadline()) {
            Ok(Some(state)) => match (state.offscreen, state.hidden) {
                (Some(false), hidden) if hidden != Some(true) => Visibility::OnScreen,
                (Some(true), _) | (Some(false), _) => Visibility::OffScreen,
                (None, _) => Visibility::Unread,
            },
            Ok(None) | Err(_) => Visibility::Unread,
        }
    }

    fn scroll(&mut self) -> Result<bool, AdapterError> {
        crate::actions::scroll_into_view(self.bus, self.handle, self.lease)
    }
}

pub(crate) fn scroll_with(
    port: &mut dyn ScrollPort,
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    let def = ChainDef {
        action: "scroll-to",
        suggestion: SUGGESTION,
    };
    let run = || {
        if port.visibility() == Visibility::OnScreen {
            return Ok(DeliveryOutcome::Satisfied);
        }
        if !port.scroll()? {
            return Ok(DeliveryOutcome::Satisfied);
        }
        Ok(DeliveryOutcome::Delivered(match port.visibility() {
            Visibility::OnScreen => Observed::Matched,
            Visibility::OffScreen => Observed::Unchanged,
            Visibility::Unread => Observed::Unread,
        }))
    };
    let mut rungs = [Rung {
        label: SCROLL_LABEL,
        run: Box::new(run),
    }];
    execute_chain(&def, &mut rungs, deadline)
}

pub(crate) fn scroll_to(
    bus: &SharedBus,
    handle: &NativeHandle,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    scroll_with(&mut BusPort { bus, handle, lease }, lease.deadline())
}

#[cfg(test)]
#[path = "scroll_wrap_tests.rs"]
mod tests;
