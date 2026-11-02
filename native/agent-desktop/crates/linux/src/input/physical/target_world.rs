use std::time::Duration;

use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, HitTestResult, InteractionLease,
    MouseButton, Point, Rect,
};
use serde_json::json;

use crate::input::backend::Backend;
use crate::input::delivery::{Delivery, Gate};
use crate::input::keyboard::keymap::Keymap;
use crate::input::keyboard::keysym_step::KeysymStep;
use crate::input::plan::Plan;
use crate::system::SharedBus;
use crate::tree::AtspiElement;

/// The desktop observations and input used by each physical leg.
pub(crate) trait PhysicalWorld {
    fn backend(&self) -> Result<Backend, AdapterError>;
    fn focus_target(&self, element: &AtspiElement, deadline: Deadline) -> Result<(), AdapterError>;
    fn target_focused(
        &self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<bool, AdapterError>;
    fn keymap(&self, deadline: Deadline) -> Result<Keymap, AdapterError>;
    fn frame_active(
        &self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<Option<bool>, AdapterError>;
    fn bounds(
        &self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError>;
    fn validate_pointer(
        &self,
        element: &AtspiElement,
        point: &Point,
        deadline: Deadline,
    ) -> Result<(), AdapterError>;
    fn plan_click(
        &self,
        map: &Keymap,
        at: Point,
        button: &MouseButton,
        count: u32,
    ) -> Result<Plan, AdapterError> {
        crate::input::mouse::pointer_plan::plan_click(map, at, button, count, &[])
    }
    fn send_plans(
        &self,
        plans: Vec<Plan>,
        gate: Gate<'_>,
        deadline: Deadline,
    ) -> Result<Delivery, AdapterError>;
    fn send_keysyms(
        &self,
        chunks: &[Vec<KeysymStep>],
        gate: Gate<'_>,
        deadline: Deadline,
    ) -> Result<Delivery, AdapterError>;
    fn pointer_refusal(&self, what: &'static str) -> AdapterError;
    fn pause(&self, duration: Duration);
}

pub(crate) fn validate_pointer_receiver(
    bus: &SharedBus,
    element: &AtspiElement,
    point: &Point,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let placed = crate::tree::live_read::live_offscreen::placement(bus, element, deadline);
    crate::input::physical::physical_aim::validate(
        point,
        &placed,
        element.scroll_container().is_some(),
    )?;
    let on_x11 = matches!(crate::input::backend::backend(), Ok(Backend::X11(_)));
    let verdict =
        if on_x11 && element.frame().is_none() && crate::system::shell::is_shell_element(element) {
            crate::system::shell::hit::hit_test(bus, element, point.clone(), deadline)?
        } else {
            crate::tree::hit_test::pointer_hit_test(bus, element, point.clone(), deadline)?
        };
    match verdict {
        HitTestResult::ReachesTarget => Ok(()),
        HitTestResult::InterceptedBy { role, name, bounds } => Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Another element intercepts the pointer target",
        )
        .with_details(json!({
            "check": "receives_events",
            "interceptor": { "role": role, "name": name, "bounds": bounds },
            "physical_delivery_started": false,
        }))
        .with_suggestion("Reveal the target and refresh the snapshot before retrying")
        .with_disposition(DeliverySemantics::not_delivered())),
        hit => Err(
            AdapterError::new(ErrorCode::ActionFailed, "Pointer delivery is unproven")
                .with_details(json!({
                    "kind": "pointer_hit_unproven",
                    "hit_test": hit,
                    "physical_delivery_started": false,
                }))
                .with_suggestion("Expose readable, unobstructed target geometry and retry")
                .with_disposition(DeliverySemantics::not_delivered()),
        ),
    }
}

pub(crate) struct LiveWorld<'a> {
    pub(crate) bus: &'a SharedBus,
    pub(crate) lease: &'a InteractionLease,
}

impl PhysicalWorld for LiveWorld<'_> {
    fn backend(&self) -> Result<Backend, AdapterError> {
        crate::input::backend::backend()
    }

    fn focus_target(&self, element: &AtspiElement, deadline: Deadline) -> Result<(), AdapterError> {
        crate::input::physical::keyboard_focus::grab(self.bus, element, deadline)
    }

    fn target_focused(
        &self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        crate::input::physical::keyboard_focus::read(self.bus, element, deadline)
    }

    fn keymap(&self, _deadline: Deadline) -> Result<Keymap, AdapterError> {
        match self.backend()? {
            Backend::X11(display) => crate::input::x11::session::live_keymap(&display, self.lease),
            Backend::Wayland => Err(self.pointer_refusal("keymap")),
        }
    }

    fn frame_active(
        &self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<Option<bool>, AdapterError> {
        let Some(frame) = element.frame() else {
            return Ok(None);
        };
        crate::input::physical::frame_active::frame_active(self.bus, frame, deadline)
    }

    fn bounds(
        &self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        let handle = element.clone().into_native_handle();
        crate::tree::get_element_bounds(self.bus, &handle, deadline)
    }

    fn validate_pointer(
        &self,
        element: &AtspiElement,
        point: &Point,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        validate_pointer_receiver(self.bus, element, point, deadline)
    }

    fn send_plans(
        &self,
        plans: Vec<Plan>,
        gate: Gate<'_>,
        _deadline: Deadline,
    ) -> Result<Delivery, AdapterError> {
        crate::input::deliver::send_plans(plans, gate, self.lease)
    }

    fn send_keysyms(
        &self,
        chunks: &[Vec<KeysymStep>],
        gate: Gate<'_>,
        deadline: Deadline,
    ) -> Result<Delivery, AdapterError> {
        crate::input::deliver::send_keysyms(chunks, gate, deadline)
    }

    fn pointer_refusal(&self, what: &'static str) -> AdapterError {
        crate::input::wayland::keysym_send::pointer_refusal(what)
    }

    fn pause(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}
