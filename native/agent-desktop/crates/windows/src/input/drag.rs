//! `InputOps::drag`: `SendInput` drag synthesis with a release guard.
//!
//! Bare-coordinate path like `mouse_event` - no window-identity gate,
//! because there is no target window to verify; `--headed` is the
//! guard, enforced upstream. The release guard arms immediately before the
//! mouse-down and disarms only after the final release posts at the
//! destination; on any abort in between, the guard's `Drop` posts
//! corrective input at the origin (`drag_state.rs`). `SendInput`'s return
//! value is never treated as delivery evidence (A9-3), so every post here
//! is fire-and-forget.

use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, DragParams, ErrorCode, Point};

use crate::input::drag_state::DragReleaseGuard;
use crate::input::mouse::mouse_coord::{self, NormalizedPoint};
use crate::input::mouse::mouse_send::{
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, button_input, move_input, post_mouse_inputs,
};
use crate::input::mouse::sleep_bounded;

const DEFAULT_DURATION_MS: u64 = 300;
const PICKUP_DELAY_MS: u64 = 200;
/// The sequence settles for a pickup delay twice - once after moving to the
/// origin so the target sees the cursor arrive before the button, and once
/// after the button lands so it registers the press before travel begins.
/// The preflight reserves both, because a gate that reserves one admits a
/// drag it cannot finish and the shortfall is spent with the button down.
const PICKUP_TOTAL_MS: u64 = PICKUP_DELAY_MS * 2;
const DEFAULT_DROP_DELAY_MS: u64 = 500;
const DWELL_TICK_MS: u64 = 16;
const MAX_STEPS: u64 = 4_096;
const MAX_DRAG_MS: u64 = 60_000;
const MAX_DROP_DELAY_MS: u64 = 30_000;

pub(crate) fn synthesize_drag(params: DragParams, deadline: Deadline) -> Result<(), AdapterError> {
    validate_drag(&params)?;
    preflight_drag(&params, deadline)?;
    drag_sequence(params, deadline)
}

fn drag_sequence(params: DragParams, deadline: Deadline) -> Result<(), AdapterError> {
    let duration_ms = params.duration_ms.unwrap_or(DEFAULT_DURATION_MS);
    let drop_delay_ms = params.drop_delay_ms.unwrap_or(DEFAULT_DROP_DELAY_MS);
    let steps = duration_ms.div_ceil(DWELL_TICK_MS).clamp(1, MAX_STEPS);
    let step_delay = Duration::from_secs_f64(duration_ms as f64 / steps as f64 / 1_000.0);
    let origin = mouse_coord::normalize_point(&params.from);
    let destination = mouse_coord::normalize_point(&params.to);

    deadline.ensure_remaining()?;
    post_mouse_inputs(&[move_input(origin)]);
    deadline.ensure_remaining()?;
    sleep_bounded(deadline, Duration::from_millis(PICKUP_DELAY_MS))?;

    let mut guard = DragReleaseGuard::new(origin);
    guard.arm();
    post_mouse_inputs(&[button_input(MOUSEEVENTF_LEFTDOWN)]);
    guard.mark_delivered();

    let outcome = (|| -> Result<(), AdapterError> {
        deadline.ensure_remaining()?;
        sleep_bounded(deadline, Duration::from_millis(PICKUP_DELAY_MS))?;

        for index in 1..=steps {
            let progress = index as f64 / steps as f64;
            let point = interpolate(&params.from, &params.to, progress);
            deadline.ensure_remaining()?;
            post_mouse_inputs(&[move_input(mouse_coord::normalize_point(&point))]);
            guard.mark_delivered();
            sleep_bounded(deadline, step_delay)?;
        }

        dwell_over_destination(destination, drop_delay_ms, deadline, &mut guard)?;

        deadline.ensure_remaining()?;
        post_mouse_inputs(&[move_input(destination)]);
        guard.mark_delivered();
        post_mouse_inputs(&[button_input(MOUSEEVENTF_LEFTUP)]);
        guard.mark_delivered();
        guard.disarm();
        deadline.ensure_remaining()
    })();

    outcome.map_err(|error| guard.enrich_error(error))
}

fn dwell_over_destination(
    destination: NormalizedPoint,
    delay_ms: u64,
    deadline: Deadline,
    guard: &mut DragReleaseGuard,
) -> Result<(), AdapterError> {
    let mut remaining_ms = delay_ms;
    while remaining_ms > 0 {
        deadline.ensure_remaining()?;
        post_mouse_inputs(&[move_input(destination)]);
        guard.mark_delivered();
        let tick_ms = remaining_ms.min(DWELL_TICK_MS);
        sleep_bounded(deadline, Duration::from_millis(tick_ms))?;
        remaining_ms -= tick_ms;
    }
    Ok(())
}

fn interpolate(from: &Point, to: &Point, progress: f64) -> Point {
    Point {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
    }
}

fn preflight_drag(params: &DragParams, deadline: Deadline) -> Result<(), AdapterError> {
    let duration_ms = params.duration_ms.unwrap_or(DEFAULT_DURATION_MS);
    let drop_delay_ms = params.drop_delay_ms.unwrap_or(DEFAULT_DROP_DELAY_MS);
    let required_ms = PICKUP_TOTAL_MS
        .checked_add(duration_ms)
        .and_then(|total| total.checked_add(drop_delay_ms))
        .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "Drag timing is too large"))?;
    let remaining = deadline.remaining();
    let required = Duration::from_millis(required_ms);
    if remaining < required {
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

fn validate_drag(params: &DragParams) -> Result<(), AdapterError> {
    params.from.validate()?;
    params.to.validate()?;
    if params.duration_ms.is_some_and(|value| value > MAX_DRAG_MS) {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("Drag duration must not exceed {MAX_DRAG_MS}ms"),
        ));
    }
    if params
        .drop_delay_ms
        .is_some_and(|value| value > MAX_DROP_DELAY_MS)
    {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("Drag drop delay must not exceed {MAX_DROP_DELAY_MS}ms"),
        ));
    }
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
#[path = "drag_tests.rs"]
mod tests;
