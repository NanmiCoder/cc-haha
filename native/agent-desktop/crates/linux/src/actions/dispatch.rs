use agent_desktop_core::{
    Action, ActionRequest, ActionResult, ActionStep, AdapterError, DeliverySemantics, ErrorCode,
    InteractionLease, InteractionPolicy, NativeHandle, StepMechanism,
};
use serde_json::json;

use super::click::{click, right_click};
use super::context::Target;
use super::disclosure::set_expanded;
use super::focus::focus;
use super::physical_target::deliver;
use super::process_check::verify_process;
use super::scroll::scroll_wrap::scroll_to;
use super::select::select;
use super::select::select_pointer::{LivePointer, Pointer};
use super::toggle_state::toggle;
use super::write::value_write::{clear, set_value, type_text};
use crate::system::SharedBus;
use crate::tree::{AtspiElement, atspi_element};

fn handled_by_core(action: &Action) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("{} requires adapter-level handling", action.name()),
    )
    .with_disposition(DeliverySemantics::not_delivered())
}

fn target_element<'a>(
    handle: &'a NativeHandle,
    action: &Action,
) -> Result<Option<&'a AtspiElement>, AdapterError> {
    if matches!(action, Action::PressKey(_)) && handle.is_null() {
        return Ok(None);
    }
    atspi_element(handle).map(Some)
}

fn reaches_physical_without_verb(action: &Action) -> bool {
    matches!(
        action,
        Action::Click | Action::RightClick | Action::TypeText(_)
    )
}

fn has_no_verb(error: &AdapterError) -> bool {
    error.code == ErrorCode::ActionNotSupported
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("semantic_verb"))
            .is_some_and(|verb| verb == "absent")
}

fn name_stopped_target(
    mut error: AdapterError,
    pid: u32,
    is_stopped: impl Fn(u32) -> bool,
) -> AdapterError {
    let uncertain = error.disposition == DeliverySemantics::uncertain();
    if error.code == ErrorCode::Timeout && uncertain && is_stopped(pid) {
        let mut details = error.details.take().unwrap_or_else(|| json!({}));
        if let Some(map) = details.as_object_mut() {
            map.insert("target_stopped".to_owned(), json!(true));
        }
        error.details = Some(details);
    }
    error
}

fn falls_back_to_semantic(error: &AdapterError) -> bool {
    let unaimable = error
        .details
        .as_ref()
        .and_then(|details| details.get("check"))
        .is_some_and(|check| check == "geometry");
    error.disposition == DeliverySemantics::not_delivered()
        && (error.code == ErrorCode::ActionNotSupported || unaimable)
}

pub(crate) fn physical_first(
    physical: impl FnOnce() -> Result<ActionResult, AdapterError>,
    semantic: impl FnOnce() -> Result<ActionResult, AdapterError>,
) -> Result<ActionResult, AdapterError> {
    match physical() {
        Err(error) if falls_back_to_semantic(&error) => semantic().map(|mut result| {
            result.steps.insert(
                0,
                ActionStep::skipped("physical_input")
                    .with_mechanism(StepMechanism::PhysicalSynthetic),
            );
            result.details.get_or_insert_with(|| json!({}))["physical_fallback"] = json!({
                "code": error.code,
                "message": error.message,
                "details": error.details,
            });
            result
        }),
        other => other,
    }
}

fn right_click_dispatch(
    policy: InteractionPolicy,
    physical: impl FnOnce() -> Result<ActionResult, AdapterError>,
    semantic: impl FnOnce() -> Result<ActionResult, AdapterError>,
) -> Result<ActionResult, AdapterError> {
    if policy.is_headed() {
        physical_first(physical, semantic)
    } else {
        semantic()
    }
}

pub(crate) fn execute_action(
    bus: &SharedBus,
    handle: &NativeHandle,
    request: ActionRequest,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    let deadline = lease.deadline();
    let element = target_element(handle, &request.action)?;
    deadline.ensure_remaining()?;
    let Some(element) = element else {
        return deliver(bus, &request.action, None, &request, lease);
    };
    verify_process(bus, element, request.expected_process(), deadline)?;
    let target = Target {
        bus,
        handle,
        element,
        deadline,
    };
    let semantic = match &request.action {
        Action::Click if request.policy.is_headed() => physical_first(
            || deliver(bus, &request.action, Some(element), &request, lease),
            || click(&target),
        ),
        Action::Click => click(&target),
        Action::RightClick => right_click_dispatch(
            request.policy,
            || deliver(bus, &request.action, Some(element), &request, lease),
            || right_click(&target),
        ),
        Action::Toggle => toggle(&target, None),
        Action::Check => toggle(&target, Some(true)),
        Action::Uncheck => toggle(&target, Some(false)),
        Action::Expand => set_expanded(&target, true),
        Action::Collapse => set_expanded(&target, false),
        Action::Select(display_value) => {
            let pointer = request.policy.is_headed().then_some(LivePointer {
                bus,
                lease,
                policy: request.policy,
            });
            select(
                &target,
                display_value,
                pointer.as_ref().map(|pointer| pointer as &dyn Pointer),
            )
        }
        Action::SetFocus => focus(&target, request.policy),
        Action::SetValue(text) => set_value(&target, text, request.policy),
        Action::Clear => clear(&target, request.policy),
        Action::TypeText(text) if request.policy.is_headed() => physical_first(
            || deliver(bus, &request.action, Some(element), &request, lease),
            || type_text(&target, text, request.policy),
        ),
        Action::TypeText(text) => type_text(&target, text, request.policy),
        Action::ScrollTo => scroll_to(bus, handle, lease),
        Action::DoubleClick | Action::TripleClick | Action::Scroll(_, _) | Action::PressKey(_) => {
            deliver(bus, &request.action, Some(element), &request, lease)
        }
        Action::Hover | Action::Drag(_) | Action::KeyDown(_) | Action::KeyUp(_) => {
            Err(handled_by_core(&request.action))
        }
    };
    match semantic {
        Err(error) if reaches_physical_without_verb(&request.action) && has_no_verb(&error) => {
            deliver(bus, &request.action, Some(element), &request, lease)
        }
        other => other.map_err(|error| {
            name_stopped_target(
                error,
                element.pid(),
                crate::system::process::proc_stat::is_stopped,
            )
        }),
    }
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod tests;
