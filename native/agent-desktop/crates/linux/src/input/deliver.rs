use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, DragParams, InteractionLease, InteractionPolicy,
    MouseEvent, MouseEventKind, OperationReport,
};

use serde_json::json;

use super::backend::{Backend, backend};
use super::delivery::{Delivery, Gate};
use super::keyboard::keysym_step::KeysymStep;
use super::mouse::drag_plan::plan_drag;
use super::mouse::pointer_report::with_event_count;
use super::plan::Plan;
use super::wayland::keysym_send;
use super::x11::{mouse_send, session};

pub(crate) fn send_plans(
    plans: Vec<Plan>,
    gate: Gate<'_>,
    lease: &InteractionLease,
) -> Result<Delivery, AdapterError> {
    match backend()? {
        Backend::X11(display) => session::run(&display, plans, gate, lease),
        Backend::Wayland => Err(keysym_send::pointer_refusal("pointer_and_chord_input")),
    }
}

pub(crate) fn send_keysyms(
    chunks: &[Vec<KeysymStep>],
    gate: Gate<'_>,
    deadline: Deadline,
) -> Result<Delivery, AdapterError> {
    match backend()? {
        Backend::X11(_) => Err(AdapterError::not_supported("x11_keysym_input")),
        Backend::Wayland => keysym_send::send_chunks(chunks, gate, deadline),
    }
}

pub(crate) fn mouse_event(
    event: &MouseEvent,
    lease: &InteractionLease,
) -> Result<OperationReport, AdapterError> {
    match &event.kind {
        MouseEventKind::Down => {
            return Err(super::standalone::reject_standalone("mouse_event down"));
        }
        MouseEventKind::Up => return Err(super::standalone::reject_standalone("mouse_event up")),
        _ => {}
    }
    match backend()? {
        Backend::X11(display) => {
            let plans = mouse_send::plans_for(&display, event, lease)?;
            let delivery = session::run(&display, plans, &mut || Ok(()), lease)?;
            Ok(with_event_count(
                OperationReport::pointer_dispatched(event, false),
                &delivery,
            ))
        }
        Backend::Wayland => Err(keysym_send::pointer_refusal("mouse_event")),
    }
}

pub(crate) fn drag(
    params: &DragParams,
    lease: &InteractionLease,
) -> Result<OperationReport, AdapterError> {
    let deadline = lease.deadline();
    match backend()? {
        Backend::X11(display) => {
            let plan = plan_drag(params, deadline)?;
            let delivery = session::run(&display, vec![plan], &mut || Ok(()), lease)?;
            Ok(with_event_count(
                OperationReport::drag_dispatched(params),
                &delivery,
            ))
        }
        Backend::Wayland => Err(keysym_send::pointer_refusal("drag")),
    }
}

pub(crate) fn ensure_budget(deadline: Deadline) -> Result<(), AdapterError> {
    if deadline.is_expired() {
        return Err(AdapterError::timeout("Operation exceeded its deadline")
            .with_details(json!({
                "kind": "deadline",
                "timeout_ms": deadline.timeout_ms(),
                "elapsed_ms": deadline.elapsed().as_millis(),
                "physical_delivery_started": false,
            }))
            .with_disposition(DeliverySemantics::not_delivered()));
    }
    Ok(())
}

pub(crate) fn ensure_keyboard_policy(policy: InteractionPolicy) -> Result<(), AdapterError> {
    if !policy.allow_focus_steal {
        return Err(AdapterError::policy_denied_for_policy(
            "Physical keyboard fallback requires focus permission",
            policy,
        ));
    }
    Ok(())
}

pub(crate) fn ensure_headed_click_policy(policy: InteractionPolicy) -> Result<(), AdapterError> {
    if !policy.allow_cursor_move || !policy.allow_focus_steal {
        return Err(AdapterError::policy_denied_for_policy(
            "Physical pointer input is disabled by the current interaction policy",
            policy,
        ));
    }
    Ok(())
}
