use std::time::Duration;

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode, Modifier, Point};

use super::pointer_plan::{pause, point_xy};
use crate::input::keyboard::key_plan::{key_down_steps, key_up_steps, modifier_codes};
use crate::input::keyboard::keymap::Keymap;
use crate::input::plan::Plan;
use crate::input::step::Step;

pub(crate) const BUTTON_WHEEL_UP: u8 = 4;
pub(crate) const BUTTON_WHEEL_DOWN: u8 = 5;
pub(crate) const BUTTON_WHEEL_LEFT: u8 = 6;
pub(crate) const BUTTON_WHEEL_RIGHT: u8 = 7;

pub(crate) const MAX_CLICKS_PER_EVENT: u32 = 10;
pub(crate) const MAX_CLICKS_PER_AXIS: u32 = 1_000;
pub(crate) const WHEEL_CLICK_GAP: Duration = Duration::from_millis(2);

pub(crate) fn plan_wheel(
    map: &Keymap,
    at: Point,
    dx: f64,
    dy: f64,
    mods: &[Modifier],
) -> Result<Vec<Plan>, AdapterError> {
    let (x, y) = point_xy(&at)?;
    let vertical = clicks(dy)?;
    let horizontal = clicks(dx)?;
    if vertical == 0 && horizontal == 0 {
        return Err(
            AdapterError::new(ErrorCode::InvalidArgs, "Wheel delta must be non-zero")
                .with_disposition(DeliverySemantics::not_delivered()),
        );
    }
    let held = modifier_codes(map, mods)?;
    let axes = [
        (vertical, BUTTON_WHEEL_UP, BUTTON_WHEEL_DOWN),
        (horizontal, BUTTON_WHEEL_RIGHT, BUTTON_WHEEL_LEFT),
    ];
    let mut plans = Vec::new();
    for (clicks, positive, negative) in axes {
        let code = if clicks >= 0 { positive } else { negative };
        let mut remaining = clicks.unsigned_abs();
        while remaining > 0 {
            let burst = remaining.min(MAX_CLICKS_PER_EVENT);
            plans.push(event_plan(&held, (x, y), code, burst));
            remaining -= burst;
        }
    }
    Ok(plans)
}

fn event_plan(held: &[(Modifier, u8)], (x, y): (i32, i32), code: u8, clicks: u32) -> Plan {
    let mut steps = key_down_steps(held);
    steps.push(Step::MoveTo { x, y });
    for index in 0..clicks {
        steps.push(Step::Button { code, down: true });
        steps.push(Step::Button { code, down: false });
        if index + 1 < clicks {
            steps.extend(pause(WHEEL_CLICK_GAP));
        }
    }
    steps.extend(key_up_steps(held));
    Plan {
        steps,
        release_origin: Some((x, y)),
    }
}

fn clicks(delta: f64) -> Result<i32, AdapterError> {
    if !delta.is_finite() || delta.abs() > f64::from(MAX_CLICKS_PER_AXIS) + 0.5 {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Wheel delta must be finite and within -1000..=1000 clicks per axis",
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    let rounded = delta.round();
    if rounded == 0.0 && delta != 0.0 {
        return Ok(if delta.is_sign_positive() { 1 } else { -1 });
    }
    Ok(rounded as i32)
}

#[cfg(test)]
#[path = "wheel_plan_tests.rs"]
mod tests;
