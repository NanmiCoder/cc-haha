use std::cell::Cell;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, Point, Rect};

use crate::input::backend::Backend;
use crate::input::delivery::{Delivery, Gate};
use crate::input::keyboard::keymap::Keymap;
use crate::input::keyboard::keysym_step::KeysymStep;
use crate::input::physical::target_world::{LiveWorld, PhysicalWorld};
use crate::input::plan::Plan;
use crate::tree::AtspiElement;

pub(in crate::actions) struct ReceiverWorld<'a> {
    pub(in crate::actions) live: LiveWorld<'a>,
    before_check: &'a dyn Fn(u32),
    checks: Cell<u32>,
}

impl<'a> ReceiverWorld<'a> {
    pub(in crate::actions) fn new(live: LiveWorld<'a>, before_check: &'a dyn Fn(u32)) -> Self {
        Self {
            live,
            before_check,
            checks: Cell::new(0),
        }
    }
}

impl PhysicalWorld for ReceiverWorld<'_> {
    fn backend(&self) -> Result<Backend, AdapterError> {
        self.live.backend()
    }

    fn focus_target(&self, element: &AtspiElement, deadline: Deadline) -> Result<(), AdapterError> {
        self.live.focus_target(element, deadline)
    }

    fn target_focused(
        &self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        self.live.target_focused(element, deadline)
    }

    fn keymap(&self, deadline: Deadline) -> Result<Keymap, AdapterError> {
        self.live.keymap(deadline)
    }

    fn frame_active(
        &self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<Option<bool>, AdapterError> {
        self.live.frame_active(element, deadline)
    }

    fn bounds(
        &self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        self.live.bounds(element, deadline)
    }

    fn validate_pointer(
        &self,
        element: &AtspiElement,
        point: &Point,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        let checks = self.checks.get();
        self.checks.set(checks + 1);
        (self.before_check)(checks);
        self.live.validate_pointer(element, point, deadline)
    }

    fn send_plans(
        &self,
        plans: Vec<Plan>,
        gate: Gate<'_>,
        deadline: Deadline,
    ) -> Result<Delivery, AdapterError> {
        self.live.send_plans(plans, gate, deadline)
    }

    fn send_keysyms(
        &self,
        chunks: &[Vec<KeysymStep>],
        gate: Gate<'_>,
        deadline: Deadline,
    ) -> Result<Delivery, AdapterError> {
        self.live.send_keysyms(chunks, gate, deadline)
    }

    fn pointer_refusal(&self, what: &'static str) -> AdapterError {
        self.live.pointer_refusal(what)
    }

    fn pause(&self, duration: Duration) {
        self.live.pause(duration);
    }
}
