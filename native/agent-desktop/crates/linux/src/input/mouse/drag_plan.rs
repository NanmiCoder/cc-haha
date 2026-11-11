use std::time::Duration;

use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, DragParams, ErrorCode, MAX_DRAG_DROP_DELAY_MS,
    MAX_DRAG_DURATION_MS, Point,
};

use super::pointer_plan::{BUTTON_LEFT, pause, point_xy};
use crate::input::plan::Plan;
use crate::input::step::Step;

pub(crate) const DEFAULT_DURATION_MS: u64 = 300;
pub(crate) const DEFAULT_DROP_DELAY_MS: u64 = 150;
pub(crate) const PICKUP_DELAY_MS: u64 = 200;
pub(crate) const TICK_MS: u64 = 16;
pub(crate) const MIN_DURATION_MS: u64 = 100;
const MAX_STEPS: u64 = 4_096;

pub(crate) fn plan_drag(params: &DragParams, deadline: Deadline) -> Result<Plan, AdapterError> {
    let origin = point_xy(&params.from)?;
    point_xy(&params.to)?;
    validate_timing(params)?;
    preflight(params, deadline)?;
    let duration_ms = params.duration_ms.unwrap_or(DEFAULT_DURATION_MS);
    let drop_delay_ms = params.drop_delay_ms.unwrap_or(DEFAULT_DROP_DELAY_MS);
    let ticks = duration_ms.div_ceil(TICK_MS).clamp(1, MAX_STEPS);
    let tick_delay = Duration::from_secs_f64(duration_ms as f64 / ticks as f64 / 1_000.0);
    let pickup = Duration::from_millis(PICKUP_DELAY_MS);
    let left = |down| Step::Button {
        code: BUTTON_LEFT,
        down,
    };

    let mut steps = vec![Step::MoveTo {
        x: origin.0,
        y: origin.1,
    }];
    steps.extend(pause(pickup));
    steps.push(left(true));
    steps.extend(pause(pickup));
    for index in 1..=ticks {
        let (x, y) = interpolate(&params.from, &params.to, index as f64 / ticks as f64);
        steps.push(Step::MoveTo { x, y });
        steps.extend(pause(tick_delay));
    }
    steps.extend(pause(Duration::from_millis(drop_delay_ms)));
    steps.push(left(false));
    Ok(Plan {
        steps,
        release_origin: Some(origin),
    })
}

fn interpolate(from: &Point, to: &Point, progress: f64) -> (i32, i32) {
    (
        (from.x + (to.x - from.x) * progress).round() as i32,
        (from.y + (to.y - from.y) * progress).round() as i32,
    )
}

fn validate_timing(params: &DragParams) -> Result<(), AdapterError> {
    if params
        .duration_ms
        .is_some_and(|duration| duration < MIN_DURATION_MS)
    {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!(
                "Drag duration must be at least {MIN_DURATION_MS}ms: a shorter gesture does not start a toolkit drag"
            ),
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    for (value, cap, label) in [
        (params.duration_ms, MAX_DRAG_DURATION_MS, "duration"),
        (params.drop_delay_ms, MAX_DRAG_DROP_DELAY_MS, "drop delay"),
    ] {
        if value.is_some_and(|value| value > cap) {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                format!("Drag {label} must not exceed {cap}ms"),
            )
            .with_disposition(DeliverySemantics::not_delivered()));
        }
    }
    Ok(())
}

fn preflight(params: &DragParams, deadline: Deadline) -> Result<(), AdapterError> {
    let required_ms = PICKUP_DELAY_MS * 2
        + params.duration_ms.unwrap_or(DEFAULT_DURATION_MS)
        + params.drop_delay_ms.unwrap_or(DEFAULT_DROP_DELAY_MS);
    let remaining = deadline.remaining();
    if remaining < Duration::from_millis(required_ms) {
        return Err(
            AdapterError::timeout("Drag cannot complete within the remaining deadline")
                .with_details(serde_json::json!({
                    "physical_delivery_started": false,
                    "required_ms": required_ms,
                    "remaining_ms": remaining.as_millis(),
                }))
                .with_disposition(DeliverySemantics::not_delivered()),
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "drag_plan_tests.rs"]
mod tests;
