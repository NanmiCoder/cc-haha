//! Physical keyboard legs for `TypeText` and `PressKey`: focus-fallback
//! policy, keyboard-focus verification, elevation gate, then `SendInput`
//! synthesis. Null-handle `PressKey` synthesizes globally with no element
//! gate.

use agent_desktop_core::{
    Action, ActionResult, ActionStep, AdapterError, Deadline, InteractionPolicy, KeyCombo,
    StepMechanism,
};

use crate::actions::physical_target::{
    ensure_keyboard_delivery_ready, ensure_keyboard_policy, focus_lost_before_delivery,
};
use crate::input::keyboard::{preflight_text, synthesize_key, synthesize_text};
use crate::tree::element::UIAElement;

const TYPE_TEXT_LABEL: &str = "SendInput.type_text";
const PRESS_KEY_LABEL: &str = "SendInput.press_key";

pub(crate) fn type_text_steps(
    element: &UIAElement,
    text: &str,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<ActionStep>, AdapterError> {
    ensure_keyboard_policy(policy)?;
    preflight_text(text, deadline)?;
    let focus_ready = ensure_keyboard_delivery_ready(element, deadline)?;
    type_text_from_gate(text, focus_ready, deadline, |deadline| {
        match ensure_keyboard_delivery_ready(element, deadline)? {
            true => Ok(()),
            false => Err(focus_lost_before_delivery()),
        }
    })
    .map(|step| vec![step])
}

pub(crate) fn press_key_element_steps(
    element: &UIAElement,
    combo: &KeyCombo,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<ActionStep>, AdapterError> {
    ensure_keyboard_policy(policy)?;
    deadline.ensure_remaining()?;
    let focus_ready = ensure_keyboard_delivery_ready(element, deadline)?;
    press_key_from_gate(combo, focus_ready, deadline).map(|step| vec![step])
}

pub(crate) fn press_key_global(
    combo: &KeyCombo,
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    deadline.ensure_remaining()?;
    synthesize_key(combo, deadline)?;
    Ok(ActionResult::from_execution(
        &Action::PressKey(combo.clone()),
        vec![physical_step(PRESS_KEY_LABEL)],
    ))
}

/// The shipped `type` leg past the focus gate, with the per-chunk verifier
/// injected so a test drives the same code the adapter runs. The verifier
/// is a parameter rather than a fixed closure because it is the only part
/// a caller can legitimately vary; the focus gate below it is not optional,
/// and a test-only copy of this function would leave it unguarded.
pub(crate) fn type_text_from_gate(
    text: &str,
    focus_ready: bool,
    deadline: Deadline,
    verify_target: impl FnMut(Deadline) -> Result<(), AdapterError>,
) -> Result<ActionStep, AdapterError> {
    if !focus_ready {
        return Err(focus_lost_before_delivery());
    }
    synthesize_text(text, deadline, verify_target)?;
    Ok(physical_step(TYPE_TEXT_LABEL))
}

pub(crate) fn press_key_from_gate(
    combo: &KeyCombo,
    focus_ready: bool,
    deadline: Deadline,
) -> Result<ActionStep, AdapterError> {
    if !focus_ready {
        return Err(focus_lost_before_delivery());
    }
    synthesize_key(combo, deadline)?;
    Ok(physical_step(PRESS_KEY_LABEL))
}

fn physical_step(label: &'static str) -> ActionStep {
    ActionStep::succeeded(label)
        .with_mechanism(StepMechanism::PhysicalSynthetic)
        .with_verified(false)
}

#[cfg(all(test, target_os = "windows"))]
#[path = "physical_keyboard_tests.rs"]
mod tests;
