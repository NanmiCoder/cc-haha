//! `InputOps::mouse_event`: `SendInput` mouse synthesis.
//!
//! Bare-coordinate path: `hover`/`mouse-move`/`mouse-click`/
//! `mouse-wheel` are all `--xy`, headed-only, and carry no target window to
//! verify, so there is no window-identity gate here - `--headed` is the
//! guard, enforced upstream. FFI reaches this method directly
//! (`crates/ffi/src/input/mouse.rs`), bypassing the core command layer, so
//! the guarantees core's commands validate are re-enforced here too: point
//! validity, click-count bounds, and the held-edge rejection.
//!
//! Delivery is best-effort throughout: `SendInput`'s return value is never
//! treated as evidence (A9-3), so every post here is fire-and-forget and
//! `Ok(())` follows injection rather than a re-read this method has no way
//! to perform for a bare coordinate.

use std::time::Duration;

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, MouseButton, MouseEvent, MouseEventKind,
    validate_mouse_click_count,
};

use crate::input::mouse::mouse_click_guard::{CLICK_SUGGESTION, ClickReleaseGuard};
use crate::input::mouse::mouse_coord::NormalizedPoint;
use crate::input::mouse::mouse_modifier::press_modifiers;
use crate::input::mouse::mouse_send::{
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
    MouseInputEvent, button_input, move_input, post_mouse_inputs,
};
use crate::input::release_state::ReleaseState;

const WHEEL_DELTA: i32 = 120;
const WHEEL_SUGGESTION: &str =
    "Re-read the target's scroll position before retrying; part of the requested scroll landed";

const MAX_LINES_PER_EVENT: i32 = 10;
const MAX_TOTAL_LINES: i32 = 1_000;
const CLICK_HOLD_DELAY: Duration = Duration::from_millis(10);
const CLICK_GAP_DELAY: Duration = Duration::from_millis(20);

pub(crate) fn synthesize_mouse(event: MouseEvent, deadline: Deadline) -> Result<(), AdapterError> {
    deadline.ensure_remaining()?;
    event.point.validate()?;
    match event.kind {
        MouseEventKind::Down | MouseEventKind::Up => Err(standalone_state_error()),
        MouseEventKind::Move => dispatch_move(&event),
        MouseEventKind::Click { count } => {
            validate_mouse_click_count(count)?;
            dispatch_click(&event, count, deadline)
        }
        MouseEventKind::Wheel { delta_x, delta_y } => {
            dispatch_wheel(&event, delta_x, delta_y, deadline)
        }
    }
}

pub(crate) fn standalone_state_error() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "Standalone mouse-down/mouse-up is unavailable in stateless mode",
    )
    .with_details(serde_json::json!({
        "raw_input_emitted": false,
        "requires_daemon_owned_transaction": true,
    }))
    .with_suggestion(
        "Use atomic 'mouse-click' or 'drag'; spanning holds require a daemon-owned session that can release buttons after disconnect",
    )
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

fn dispatch_move(event: &MouseEvent) -> Result<(), AdapterError> {
    let normalized = mouse_coord::normalize_point(&event.point);
    post_mouse_inputs(&[move_input(normalized)]);
    Ok(())
}

fn dispatch_click(event: &MouseEvent, count: u32, deadline: Deadline) -> Result<(), AdapterError> {
    deadline.ensure_remaining()?;
    let normalized = mouse_coord::normalize_point(&event.point);
    let mut modifiers = press_modifiers(&event.modifiers);
    let result = post_click_sequence(&event.button, normalized, count, deadline);
    modifiers.release();
    result
}

/// Delivery accounting spans the whole sequence while cleanup stays per
/// click: a `--count 3` that aborts on the third click has still posted
/// five events, and reporting only the third click's two would tell the
/// caller less input landed than did. The per-click guard owns the
/// corrective up-post because only it knows which button is down now.
fn post_click_sequence(
    button: &MouseButton,
    normalized: NormalizedPoint,
    count: u32,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    post_mouse_inputs(&[move_input(normalized)]);
    let (down_flag, up_flag) = button_flags(button);
    let mut sequence = ReleaseState::default();
    for click_index in 0..count {
        if let Err(error) = deadline.ensure_remaining() {
            return Err(sequence.enrich_error(error, CLICK_SUGGESTION));
        }
        let mut guard = ClickReleaseGuard::new(up_flag);
        let outcome = click_once(down_flag, up_flag, &mut guard, &mut sequence, deadline);
        if let Err(error) = outcome {
            return Err(sequence.enrich_error(error, CLICK_SUGGESTION));
        }
        if click_index + 1 < count
            && let Err(error) = sleep_bounded(deadline, CLICK_GAP_DELAY)
        {
            return Err(sequence.enrich_error(error, CLICK_SUGGESTION));
        }
    }
    Ok(())
}

fn click_once(
    down_flag: u32,
    up_flag: u32,
    guard: &mut ClickReleaseGuard,
    sequence: &mut ReleaseState,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    guard.arm();
    sequence.arm();
    post_mouse_inputs(&[button_input(down_flag)]);
    sequence.mark_delivered();
    sleep_bounded(deadline, CLICK_HOLD_DELAY)?;
    post_mouse_inputs(&[button_input(up_flag)]);
    sequence.mark_delivered();
    guard.disarm();
    sequence.disarm();
    Ok(())
}

fn dispatch_wheel(
    event: &MouseEvent,
    delta_x: f64,
    delta_y: f64,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let y_chunks = signed_chunks(wheel_lines_to_i32(delta_y)?)?;
    let x_chunks = signed_chunks(wheel_lines_to_i32(delta_x)?)?;
    if y_chunks.is_empty() && x_chunks.is_empty() {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Wheel delta must be non-zero",
        ));
    }
    let normalized = mouse_coord::normalize_point(&event.point);
    post_mouse_inputs(&[move_input(normalized)]);
    let mut modifiers = press_modifiers(&event.modifiers);
    let result = post_wheel_chunks(y_chunks, x_chunks, deadline);
    modifiers.release();
    result
}

/// A large delta is split across several events, so a deadline crossed
/// part-way through has already scrolled the target some of the way. The
/// error carries how many chunks landed rather than reporting a scroll that
/// never happened; no button or key is held here, so there is nothing to
/// release - only the count is at stake.
fn post_wheel_chunks(
    y_chunks: Vec<i32>,
    x_chunks: Vec<i32>,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let mut delivered = ReleaseState::default();
    for (flag, chunks) in [
        (MOUSEEVENTF_WHEEL, y_chunks),
        (MOUSEEVENTF_HWHEEL, x_chunks),
    ] {
        for lines in chunks {
            if let Err(error) = deadline.ensure_remaining() {
                return Err(delivered.enrich_error(error, WHEEL_SUGGESTION));
            }
            post_mouse_inputs(&[wheel_input(flag, lines)]);
            delivered.mark_delivered();
        }
    }
    Ok(())
}

fn wheel_input(flag: u32, lines: i32) -> MouseInputEvent {
    MouseInputEvent {
        dx: 0,
        dy: 0,
        mouse_data: lines.saturating_mul(WHEEL_DELTA),
        flags: flag,
    }
}

fn button_flags(button: &MouseButton) -> (u32, u32) {
    match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
}

fn wheel_lines_to_i32(delta: f64) -> Result<i32, AdapterError> {
    if !delta.is_finite() || delta < f64::from(i32::MIN) || delta > f64::from(i32::MAX) {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Wheel line delta must be a finite 32-bit value",
        ));
    }
    let rounded = delta.round();
    if rounded == 0.0 && delta != 0.0 {
        return Ok(if delta.is_sign_positive() { 1 } else { -1 });
    }
    Ok(rounded as i32)
}

fn signed_chunks(value: i32) -> Result<Vec<i32>, AdapterError> {
    if value == 0 {
        return Ok(Vec::new());
    }
    if value.unsigned_abs() > MAX_TOTAL_LINES as u32 {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Wheel delta must be within -1000..=1000 lines per axis",
        ));
    }
    let mut remaining = value;
    let mut chunks = Vec::new();
    while remaining != 0 {
        let next = remaining.clamp(-MAX_LINES_PER_EVENT, MAX_LINES_PER_EVENT);
        chunks.push(next);
        remaining -= next;
    }
    Ok(chunks)
}

pub(crate) fn sleep_bounded(deadline: Deadline, duration: Duration) -> Result<(), AdapterError> {
    let capped = deadline.remaining_slice(duration)?;
    std::thread::sleep(capped);
    deadline.ensure_remaining()
}

/// Shared test fixtures for `mouse_tests.rs`, `mouse_wheel_tests.rs`, and
/// `mouse_modifier_tests.rs` — one definition per helper instead of a
/// hand-copied one per file.
#[cfg(all(test, target_os = "windows"))]
pub(crate) mod fixture {
    use crate::input::keyboard::keyboard_send::keyboard_send_fake_sink as key_sink;
    use crate::input::mouse::mouse_send::mouse_send_fake_sink as mouse_sink;
    use agent_desktop_core::Point;

    pub(crate) fn reset_sinks() {
        mouse_sink::reset();
        key_sink::reset();
    }

    /// The one keyboard seam records full `KeyboardInputEvent`s; `key_input`
    /// sets `flags` to `KEYEVENTF_KEYUP` for a release and 0 for a press, so a
    /// non-zero flag is the key-up.
    pub(crate) fn modifier_events() -> Vec<(u16, bool)> {
        key_sink::recorded()
            .into_iter()
            .map(|event| (event.vk, event.flags != 0))
            .collect()
    }

    pub(crate) fn origin() -> Point {
        Point { x: 1.0, y: 1.0 }
    }
}

pub(super) mod mouse_click_guard;
pub(super) mod mouse_coord;
pub(super) mod mouse_modifier;
pub(crate) mod mouse_send;
#[cfg(all(test, target_os = "windows"))]
#[path = "mouse_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "mouse_wheel_tests.rs"]
mod wheel_tests;
