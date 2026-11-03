//! Physical click legs for `DoubleClick`, `TripleClick`, and `RightClick`:
//! headed policy, bounds midpoint, window-foreground verification,
//! elevation gate, then `SendInput` mouse synthesis.

use agent_desktop_core::{
    ActionStep, AdapterError, Deadline, InteractionPolicy, MouseButton, MouseEvent, MouseEventKind,
    Point, StepMechanism,
};

use crate::actions::physical_target::{
    delivery_point, ensure_click_delivery_ready, ensure_headed_click_policy,
    focus_lost_before_delivery, read_click_bounds,
};
use crate::input::mouse::synthesize_mouse;
use crate::tree::element::UIAElement;

const CLICK_LABEL: &str = "SendInput.click";

/// What click to perform — shared by the physical click legs and the
/// `click_from_gate` seam, so neither exceeds the 5-parameter cap.
pub(crate) struct ClickSpec {
    pub(crate) button: MouseButton,
    pub(crate) count: u32,
}

/// Preflight-established delivery gate: the target's live bounds and
/// whether its window was confirmed foreground before physical input
/// commits.
pub(crate) struct ClickGate {
    pub(crate) bounds: agent_desktop_core::Rect,
    pub(crate) foreground_ready: bool,
}

pub(crate) fn double_click_steps(
    element: &UIAElement,
    policy: InteractionPolicy,
    deadline: Deadline,
    verified_point: Option<Point>,
) -> Result<Vec<ActionStep>, AdapterError> {
    physical_click_steps(
        element,
        ClickSpec {
            button: MouseButton::Left,
            count: 2,
        },
        policy,
        deadline,
        verified_point.as_ref(),
    )
}

pub(crate) fn triple_click_steps(
    element: &UIAElement,
    policy: InteractionPolicy,
    deadline: Deadline,
    verified_point: Option<Point>,
) -> Result<Vec<ActionStep>, AdapterError> {
    physical_click_steps(
        element,
        ClickSpec {
            button: MouseButton::Left,
            count: 3,
        },
        policy,
        deadline,
        verified_point.as_ref(),
    )
}

pub(crate) fn right_click_steps(
    element: &UIAElement,
    policy: InteractionPolicy,
    deadline: Deadline,
    verified_point: Option<Point>,
) -> Result<Vec<ActionStep>, AdapterError> {
    physical_click_steps(
        element,
        ClickSpec {
            button: MouseButton::Right,
            count: 1,
        },
        policy,
        deadline,
        verified_point.as_ref(),
    )
}

pub(crate) fn physical_click_steps(
    element: &UIAElement,
    spec: ClickSpec,
    policy: InteractionPolicy,
    deadline: Deadline,
    verified_point: Option<&Point>,
) -> Result<Vec<ActionStep>, AdapterError> {
    ensure_headed_click_policy(policy)?;
    deadline.ensure_remaining()?;
    let foreground_ready = ensure_click_delivery_ready(element, deadline)?;
    let bounds = read_click_bounds(element)?;
    click_from_gate(
        ClickGate {
            bounds,
            foreground_ready,
        },
        verified_point,
        spec,
        deadline,
    )
    .map(|step| vec![step])
}

pub(crate) fn click_from_gate(
    gate: ClickGate,
    verified_point: Option<&Point>,
    spec: ClickSpec,
    deadline: Deadline,
) -> Result<ActionStep, AdapterError> {
    if !gate.foreground_ready {
        return Err(focus_lost_before_delivery());
    }
    let point = delivery_point(gate.bounds, verified_point)?;
    point.validate()?;
    synthesize_mouse(
        MouseEvent {
            kind: MouseEventKind::Click { count: spec.count },
            point,
            button: spec.button,
            modifiers: Vec::new(),
        },
        deadline,
    )?;
    Ok(ActionStep::succeeded(CLICK_LABEL)
        .with_mechanism(StepMechanism::PhysicalSynthetic)
        .with_verified(false))
}

#[cfg(all(test, target_os = "windows"))]
#[path = "physical_click_tests.rs"]
mod tests;
