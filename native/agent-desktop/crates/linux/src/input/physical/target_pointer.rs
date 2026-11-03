use agent_desktop_core::{
    ActionStep, AdapterError, Deadline, DeliverySemantics, Direction, ErrorCode, InteractionLease,
    InteractionPolicy, MouseButton, MouseEvent, MouseEventKind, NativeHandle, Point, Rect,
    StepMechanism, validate_mouse_click_count,
};
use serde_json::json;

use crate::input::backend::Backend;
use crate::input::deliver::{ensure_budget, ensure_headed_click_policy};
use crate::input::keyboard::keymap::Keymap;
use crate::input::mouse::gesture::Gesture;
use crate::input::mouse::press_clock::PressClock;
use crate::input::physical::target_world::{LiveWorld, PhysicalWorld};
use crate::input::plan::Plan;
use crate::input::step::Step;
use crate::system::SharedBus;
use crate::tree::{AtspiElement, atspi_element};

pub(crate) struct ClickSpec {
    pub(crate) button: MouseButton,
    pub(crate) count: u32,
    pub(crate) verified: Option<Point>,
}

impl ClickSpec {
    pub(crate) fn left(count: u32, verified: Option<Point>) -> Self {
        Self {
            button: MouseButton::Left,
            count,
            verified,
        }
    }

    pub(crate) fn right(verified: Option<Point>) -> Self {
        Self {
            button: MouseButton::Right,
            count: 1,
            verified,
        }
    }
}

pub(crate) fn click_steps(
    world: &impl PhysicalWorld,
    element: &AtspiElement,
    spec: ClickSpec,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<ActionStep>, AdapterError> {
    ensure_headed_click_policy(policy)?;
    ensure_budget(deadline)?;
    if world.backend()? == Backend::Wayland {
        return Err(world.pointer_refusal("click"));
    }
    let at = aim_point(world, element, spec.verified.as_ref(), deadline)?;
    let map = Keymap::default();
    validate_mouse_click_count(spec.count)?;
    let plans = vec![world.plan_click(&map, at.clone(), &spec.button, spec.count)?];
    send_bursts(world, element, &at, Gesture::clicks(plans), deadline)?;
    Ok(vec![
        ActionStep::succeeded("XTEST.click")
            .with_mechanism(StepMechanism::PhysicalSynthetic)
            .with_verified(false),
    ])
}

/// Wheel deltas for a scroll request. A positive vertical delta is a wheel
/// turn away from the user, which moves the content down; a positive
/// horizontal delta moves the content to the right.
pub(crate) fn wheel_deltas(direction: &Direction, amount: u32) -> (f64, f64) {
    let notches = f64::from(amount);
    match direction {
        Direction::Up => (0.0, notches),
        Direction::Down => (0.0, -notches),
        Direction::Left => (-notches, 0.0),
        Direction::Right => (notches, 0.0),
    }
}

/// Proves the receiver at the fixed wheel position before every burst.
pub(crate) fn scroll_steps(
    world: &impl PhysicalWorld,
    element: &AtspiElement,
    deltas: (f64, f64),
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<ActionStep>, AdapterError> {
    ensure_headed_click_policy(policy)?;
    ensure_budget(deadline)?;
    if world.backend()? == Backend::Wayland {
        return Err(world.pointer_refusal("scroll"));
    }
    let at = aim_point(world, element, None, deadline)?;
    let map = Keymap::default();
    let plans =
        crate::input::mouse::wheel_plan::plan_wheel(&map, at.clone(), deltas.0, deltas.1, &[])?;
    send_bursts(world, element, &at, Gesture::unbounded(plans), deadline)?;
    Ok(vec![
        ActionStep::succeeded("XTEST.scroll")
            .with_mechanism(StepMechanism::PhysicalSynthetic)
            .with_verified(false),
    ])
}

pub(crate) fn send_bursts(
    world: &impl PhysicalWorld,
    element: &AtspiElement,
    at: &Point,
    gesture: Gesture,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let Gesture {
        plans,
        press_budget,
    } = gesture;
    let plans: Vec<Plan> = plans
        .into_iter()
        .flat_map(|mut plan| {
            let boundary = plan
                .steps
                .iter()
                .position(|step| matches!(step, Step::MoveTo { .. }))
                .map(|index| index + 1);
            let Some(boundary) = boundary else {
                return vec![plan];
            };
            let buttons = Plan {
                steps: plan.steps.split_off(boundary),
                release_origin: plan.release_origin,
            };
            vec![plan, buttons]
        })
        .collect();
    let clicks: Vec<u32> = plans
        .iter()
        .map(|plan| {
            plan.steps
                .iter()
                .filter(|step| matches!(step, Step::Button { down: true, .. }))
                .count() as u32
        })
        .collect();
    let mut clock = PressClock::new(press_budget);
    let mut next = 0;
    world.send_plans(
        plans,
        &mut || {
            let pressing = clicks[next] > 0;
            let proven = if pressing {
                clock.check_deadline(deadline)
            } else {
                Ok(deadline)
            }
            .and_then(|check| {
                world
                    .validate_pointer(element, at, check)
                    .map_err(|error| clock.explain(error, check, deadline))
            });
            proven.map_err(|mut error| {
                let details = error.details.get_or_insert_with(|| serde_json::json!({}));
                details["delivered_clicks"] = clicks[..next].iter().sum::<u32>().into();
                error
            })?;
            if pressing {
                clock.pressed();
            }
            next += 1;
            Ok(())
        },
        deadline,
    )?;
    Ok(())
}

pub(crate) fn confirm_receiver(
    bus: &SharedBus,
    handle: &NativeHandle,
    point: &Point,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if crate::system::tray::target_of(handle).is_some()
        || matches!(crate::input::backend::backend(), Ok(Backend::Wayland))
    {
        return Ok(());
    }
    let element = atspi_element(handle)?;
    super::target_world::validate_pointer_receiver(bus, element, point, deadline)
}

pub(crate) fn aim_point(
    world: &impl PhysicalWorld,
    element: &AtspiElement,
    verified: Option<&Point>,
    deadline: Deadline,
) -> Result<Point, AdapterError> {
    if let Some(point) = verified {
        point.validate()?;
        return Ok(point.clone());
    }
    match world.bounds(element, deadline)? {
        Some(rect) if rect.width > 0.0 && rect.height > 0.0 => {
            let point = Point {
                x: rect.x + rect.width / 2.0,
                y: rect.y + rect.height / 2.0,
            };
            point.validate()?;
            Ok(point)
        }
        _ => Err(geometry_refusal()),
    }
}

fn geometry_refusal() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The pointer position of the target cannot be established, so no event was sent",
    )
    .with_suggestion("Run 'snapshot' to refresh, or use the semantic action instead")
    .with_details(json!({
        "check": "geometry",
        "physical_delivery_started": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn click_shell(
    bus: &SharedBus,
    node: &AtspiElement,
    button: MouseButton,
    policy: InteractionPolicy,
    lease: &InteractionLease,
) -> Result<Point, AdapterError> {
    ensure_headed_click_policy(policy)?;
    let deadline = lease.deadline();
    ensure_budget(deadline)?;
    let extents = crate::system::shell::light::live_extents(bus, node, deadline)?
        .map(Rect::from)
        .ok_or_else(geometry_refusal)?;
    let displays = crate::system::list_displays(deadline)?;
    let point = super::shell_aim::aim(extents, &displays)?;
    let world = LiveWorld { bus, lease };
    match world.backend()? {
        Backend::X11(_) => {
            click_steps(
                &world,
                node,
                ClickSpec {
                    button,
                    count: 1,
                    verified: Some(point.clone()),
                },
                policy,
                deadline,
            )?;
        }
        Backend::Wayland => {
            world.validate_pointer(node, &point, deadline)?;
            crate::input::wayland::pointer_send::send(
                &MouseEvent {
                    point: point.clone(),
                    button,
                    kind: MouseEventKind::Click { count: 1 },
                    modifiers: Vec::new(),
                },
                &displays,
                &mut || world.validate_pointer(node, &point, deadline),
                deadline,
            )?;
        }
    }
    Ok(point)
}

#[cfg(test)]
#[path = "target_click_tests.rs"]
mod click_tests;

#[cfg(test)]
#[path = "click_window_tests.rs"]
mod window_tests;

#[cfg(test)]
#[path = "target_scroll_tests.rs"]
mod scroll_tests;

#[cfg(test)]
#[path = "shell_click_live_tests.rs"]
mod shell_live_tests;
