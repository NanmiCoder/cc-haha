use agent_desktop_core::{
    Action, ActionResult, ActionStep, AdapterError, Deadline, InteractionPolicy, KeyCombo,
    StepMechanism,
};

use crate::input::backend::Backend;
use crate::input::deliver::{ensure_budget, ensure_keyboard_policy};
use crate::input::delivery::Gate;
use crate::input::physical::frame_active::ActiveGate;
use crate::input::physical::target_world::PhysicalWorld;
use crate::tree::AtspiElement;

pub(crate) fn target_steps(
    world: &impl PhysicalWorld,
    element: &AtspiElement,
    action: &Action,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<ActionStep>, AdapterError> {
    if matches!(action, Action::TypeText(text) if text.is_empty()) {
        return Ok(Vec::new());
    }
    ensure_keyboard_policy(policy)?;
    ensure_budget(deadline)?;
    let backend = world.backend()?;
    let mut active = ActiveGate::new(world, element, deadline);
    crate::input::physical::keyboard_focus::prepare(world, element, deadline)?;
    let mut gate = || {
        active.check()?;
        if world.target_focused(element, deadline)? {
            Ok(())
        } else {
            Err(crate::input::physical::keyboard_focus::refused())
        }
    };
    gate()?;
    let operation = match action {
        Action::TypeText(text) => {
            match &backend {
                Backend::X11(_) => {
                    let map = world.keymap(deadline)?;
                    let plans = crate::input::keyboard::text_plan::plan_text(&map, text)?;
                    world.send_plans(plans, &mut gate, deadline)?;
                }
                Backend::Wayland => {
                    let chunks = crate::input::keyboard::text_plan::plan_text_keysyms(text);
                    world.send_keysyms(&chunks, &mut gate, deadline)?;
                }
            }
            "type_text"
        }
        Action::PressKey(combo) => {
            send_combo(world, &backend, combo, &mut gate, deadline)?;
            "press_key"
        }
        _ => return Err(AdapterError::not_supported(action.name())),
    };
    Ok(vec![physical_step(&backend, operation)])
}

pub(crate) fn press_key_global_steps(
    world: &impl PhysicalWorld,
    combo: &KeyCombo,
    deadline: Deadline,
) -> Result<Vec<ActionStep>, AdapterError> {
    ensure_budget(deadline)?;
    let backend = world.backend()?;
    send_combo(world, &backend, combo, &mut || Ok(()), deadline)?;
    Ok(vec![physical_step(&backend, "press_key")])
}

/// Presses a chord for one process under the caller's focus gate. The gate
/// decides whether the keys may go; the focus-steal policy only words the
/// refusal, because an application that owns the active window is the target
/// whatever the policy says.
pub(crate) fn press_for_process(
    world: &impl PhysicalWorld,
    combo: &KeyCombo,
    policy: InteractionPolicy,
    gate: Gate<'_>,
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    ensure_budget(deadline)?;
    let backend = world.backend()?;
    gate().map_err(|error| worded_for(error, policy, &backend))?;
    send_combo(world, &backend, combo, gate, deadline)?;
    Ok(ActionResult::from_execution(
        &Action::PressKey(combo.clone()),
        vec![physical_step(&backend, "press_key")],
    ))
}

fn worded_for(
    mut error: AdapterError,
    policy: InteractionPolicy,
    backend: &Backend,
) -> AdapterError {
    let focus = error
        .details
        .as_ref()
        .and_then(|details| details.get("check"))
        .and_then(serde_json::Value::as_str)
        == Some("window_active");
    if !focus {
        return error;
    }
    let (message, suggestion) = if matches!(backend, Backend::Wayland) {
        (
            "The target application's active window could not be confirmed, so no key was sent",
            "On Wayland, bring the target window to the front yourself, then use global press without --app, --window-id or --headed; global keys go to the focused window and automatic activation is unavailable",
        )
    } else if policy.allow_focus_steal {
        (
            "Focus on the target application could not be confirmed, so no key was sent",
            "Retry once the target application owns the active window; a menu or dialog of another application can hold the keyboard",
        )
    } else {
        (
            "The target application's active window could not be confirmed and focus changes are not allowed, so no key was sent",
            "Retry with --headed so the target can be activated first, or bring the target to the front yourself",
        )
    };
    error.message = message.to_owned();
    error.suggestion = Some(suggestion.to_owned());
    error
}

fn send_combo(
    world: &impl PhysicalWorld,
    backend: &Backend,
    combo: &KeyCombo,
    gate: Gate<'_>,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    match backend {
        Backend::X11(_) => {
            let map = world.keymap(deadline)?;
            let plan = crate::input::keyboard::key_plan::plan_combo(&map, combo)?;
            world.send_plans(vec![plan], gate, deadline)?;
        }
        Backend::Wayland => {
            let keys = crate::input::keyboard::key_plan::plan_keysyms(combo)?;
            world.send_keysyms(&[keys], gate, deadline)?;
        }
    }
    Ok(())
}

fn physical_step(backend: &Backend, operation: &'static str) -> ActionStep {
    let label = match (backend, operation) {
        (Backend::X11(_), "type_text") => "XTEST.type_text",
        (Backend::X11(_), _) => "XTEST.press_key",
        (Backend::Wayland, "type_text") => "RemoteDesktop.type_text",
        (Backend::Wayland, _) => "RemoteDesktop.press_key",
    };
    ActionStep::succeeded(label)
        .with_mechanism(StepMechanism::PhysicalSynthetic)
        .with_verified(false)
}

#[cfg(test)]
#[path = "target_keyboard_tests.rs"]
mod tests;
