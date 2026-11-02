use agent_desktop_core::{
    Action, ActionOps, ActionResult, ActionStep, AdapterError, InteractionLease, NativeHandle,
    StepMechanism, actions::action_request::ActionRequest,
};

use crate::adapter::{MacOSAdapter, ax_element};

impl ActionOps for MacOSAdapter {
    fn execute_action(
        &self,
        handle: &NativeHandle,
        request: ActionRequest,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        if handle.is_null() {
            return execute_global_action(request, lease);
        }
        execute_action_impl(handle, request, lease)
    }

    fn scroll_into_view(
        &self,
        handle: &NativeHandle,
        lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        crate::actions::scroll_into_view::scroll_into_view_impl(
            ax_element(handle)?,
            lease.deadline(),
        )
    }
}

fn execute_action_impl(
    handle: &NativeHandle,
    request: ActionRequest,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    crate::actions::perform_action(ax_element(handle)?, &request, lease.deadline())
}

fn execute_global_action(
    request: ActionRequest,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    let Action::PressKey(combo) = request.action else {
        return Err(AdapterError::not_supported("global element action"));
    };
    crate::input::keyboard::synthesize_key(&combo, None, lease.deadline())?;
    Ok(
        ActionResult::delivered_unverified("press_key").with_steps(vec![
            ActionStep::succeeded("CGEventPost")
                .with_mechanism(StepMechanism::PhysicalSynthetic)
                .with_verified(false),
        ]),
    )
}
