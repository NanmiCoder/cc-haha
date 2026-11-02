use crate::AdAdapter;
use crate::error::{self, AdResult};
use crate::ffi_try::trap_panic;
use crate::types::{AdModifier, AdMouseButton, AdMouseEvent, AdMouseEventKind};
use agent_desktop_core::{
    Modifier as CoreModifier, MouseButton as CoreMouseButton, MouseEvent as CoreMouseEvent,
    MouseEventKind as CoreMouseEventKind, Point as CorePoint,
};

/// Four modifier keys exist (`AdModifier::{Meta, Ctrl, Alt, Shift}`), so a
/// chord can name at most four. Anything larger must be bogus input — bail
/// out instead of trusting it into `from_raw_parts`.
const MAX_MOUSE_MODIFIERS: u32 = 4;
const ALL_MODIFIER_BITS: u32 = 0b1111;

pub(crate) fn mouse_button_from_c(b: AdMouseButton) -> CoreMouseButton {
    match b {
        AdMouseButton::Left => CoreMouseButton::Left,
        AdMouseButton::Right => CoreMouseButton::Right,
        AdMouseButton::Middle => CoreMouseButton::Middle,
    }
}

/// Parses a `modifiers` array + count pair into a `Vec<Modifier>`, mirroring
/// `AdKeyCombo`'s `modifiers`/`modifier_count` contract so mouse chords and
/// key chords validate identically at the C boundary.
///
/// # Safety
/// `modifiers` must point to `count` valid `int32_t` values, or be null when
/// `count` is 0.
pub(crate) unsafe fn modifiers_from_c(
    modifiers: *const i32,
    count: u32,
) -> Result<Vec<CoreModifier>, &'static str> {
    if count > MAX_MOUSE_MODIFIERS {
        return Err("modifier_count exceeds MAX_MOUSE_MODIFIERS (4)");
    }
    if count > 0 && modifiers.is_null() {
        return Err("modifier_count > 0 but modifiers pointer is null");
    }
    let mut out = Vec::with_capacity(count as usize);
    if count > 0 {
        let slice = unsafe { std::slice::from_raw_parts(modifiers, count as usize) };
        for raw_modifier in slice {
            let m = AdModifier::from_c(*raw_modifier).ok_or("invalid modifier discriminant")?;
            out.push(match m {
                AdModifier::Meta => CoreModifier::Meta,
                AdModifier::Ctrl => CoreModifier::Ctrl,
                AdModifier::Alt => CoreModifier::Alt,
                AdModifier::Shift => CoreModifier::Shift,
            });
        }
    }
    Ok(out)
}

fn modifiers_from_mask(mask: u32) -> Result<Vec<CoreModifier>, &'static str> {
    if mask & !ALL_MODIFIER_BITS != 0 {
        return Err("modifier mask contains unknown bits");
    }
    let mut modifiers = Vec::new();
    for (bit, modifier) in [
        (0, CoreModifier::Meta),
        (1, CoreModifier::Ctrl),
        (2, CoreModifier::Alt),
        (3, CoreModifier::Shift),
    ] {
        if mask & (1 << bit) != 0 {
            modifiers.push(modifier);
        }
    }
    Ok(modifiers)
}

fn build_mouse_event(
    ev: &AdMouseEvent,
    modifiers: Vec<CoreModifier>,
) -> Result<CoreMouseEvent, &'static str> {
    let validated_button =
        AdMouseButton::from_c(ev.button).ok_or("invalid mouse button discriminant")?;
    let validated_kind =
        AdMouseEventKind::from_c(ev.kind).ok_or("invalid mouse event kind discriminant")?;
    let point = CorePoint {
        x: ev.point.x,
        y: ev.point.y,
    };
    point
        .validate()
        .map_err(|_| "mouse coordinates exceed supported geometry bounds")?;
    let button = mouse_button_from_c(validated_button);
    let kind = match validated_kind {
        AdMouseEventKind::Move => CoreMouseEventKind::Move,
        AdMouseEventKind::Down => CoreMouseEventKind::Down,
        AdMouseEventKind::Up => CoreMouseEventKind::Up,
        AdMouseEventKind::Click => {
            agent_desktop_core::validate_mouse_click_count(ev.click_count)
                .map_err(|_| "click_count must be between 1 and 100")?;
            CoreMouseEventKind::Click {
                count: ev.click_count,
            }
        }
    };
    Ok(CoreMouseEvent {
        kind,
        point,
        button,
        modifiers,
    })
}

/// Dispatches an explicit physical mouse event (move / down / up / click)
/// at the given screen point. Click count is only consulted when `event.kind`
/// is `CLICK` (e.g., `click_count == 2` for a double-click). Callers that
/// need headless policy enforcement should use ref actions with policy.
/// Carries no modifier chord — use [`ad_mouse_event_with_modifiers`] for
/// meta/ctrl/alt/shift-held clicks.
///
/// # Safety
/// `adapter` must be a non-null pointer returned by `ad_adapter_create`.
/// `event` must be a non-null pointer to a valid `AdMouseEvent`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_mouse_event(
    adapter: *const AdAdapter,
    event: *const AdMouseEvent,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(event, c"event is null");
        let ev = &*event;
        let core_event = match build_mouse_event(ev, Vec::new()) {
            Ok(e) => e,
            Err(msg) => {
                error::set_last_error(&agent_desktop_core::AdapterError::new(
                    agent_desktop_core::ErrorCode::InvalidArgs,
                    msg,
                ));
                return AdResult::ErrInvalidArgs;
            }
        };
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
        match adapter.inner.mouse_event(core_event, &lease) {
            Ok(_) => AdResult::Ok,
            Err(e) => {
                error::set_last_error(&e);
                error::last_error_code()
            }
        }
    })
}

/// Additive counterpart to [`ad_mouse_event`] that also carries a held
/// modifier chord (meta/ctrl/alt/shift) — e.g. Meta-click for additive
/// selection, shift-click for range selection. `AdMouseEvent`'s layout is
/// unchanged; modifiers travel as a separate array + count, mirroring
/// `AdKeyCombo::modifiers`/`modifier_count`.
///
/// # Safety
/// `adapter` must be a non-null pointer returned by `ad_adapter_create`.
/// `event` must be a non-null pointer to a valid `AdMouseEvent`.
/// `modifiers` must point to `modifier_count` valid `int32_t` values, or be
/// null when `modifier_count` is 0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_mouse_event_with_modifiers(
    adapter: *const AdAdapter,
    event: *const AdMouseEvent,
    modifiers: *const i32,
    modifier_count: u32,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(event, c"event is null");
        let ev = &*event;
        let mods = match modifiers_from_c(modifiers, modifier_count) {
            Ok(m) => m,
            Err(msg) => {
                error::set_last_error(&agent_desktop_core::AdapterError::new(
                    agent_desktop_core::ErrorCode::InvalidArgs,
                    msg,
                ));
                return AdResult::ErrInvalidArgs;
            }
        };
        let core_event = match build_mouse_event(ev, mods) {
            Ok(e) => e,
            Err(msg) => {
                error::set_last_error(&agent_desktop_core::AdapterError::new(
                    agent_desktop_core::ErrorCode::InvalidArgs,
                    msg,
                ));
                return AdResult::ErrInvalidArgs;
            }
        };
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
        match adapter.inner.mouse_event(core_event, &lease) {
            Ok(_) => AdResult::Ok,
            Err(e) => {
                error::set_last_error(&e);
                error::last_error_code()
            }
        }
    })
}

/// Dispatches a physical wheel event using platform-neutral line deltas.
/// Positive `delta_y` scrolls up and negative scrolls down; positive
/// `delta_x` scrolls left and negative scrolls right. `modifier_mask` uses
/// bits 0-3 for meta, ctrl, alt, and shift respectively.
///
/// # Safety
/// `adapter` must be a non-null pointer returned by `ad_adapter_create`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_mouse_wheel(
    adapter: *const AdAdapter,
    point: crate::types::AdPoint,
    delta_x: f64,
    delta_y: f64,
    modifier_mask: u32,
) -> AdResult {
    trap_panic(|| {
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        let point = CorePoint {
            x: point.x,
            y: point.y,
        };
        if point.validate().is_err() || !delta_x.is_finite() || !delta_y.is_finite() {
            let err = agent_desktop_core::AdapterError::new(
                agent_desktop_core::ErrorCode::InvalidArgs,
                "wheel coordinates and line deltas must be finite",
            );
            error::set_last_error(&err);
            return AdResult::ErrInvalidArgs;
        }
        let modifiers = match modifiers_from_mask(modifier_mask) {
            Ok(modifiers) => modifiers,
            Err(message) => {
                let err = agent_desktop_core::AdapterError::new(
                    agent_desktop_core::ErrorCode::InvalidArgs,
                    message,
                );
                error::set_last_error(&err);
                return AdResult::ErrInvalidArgs;
            }
        };
        let event = CoreMouseEvent {
            kind: CoreMouseEventKind::Wheel { delta_x, delta_y },
            point,
            button: CoreMouseButton::Left,
            modifiers,
        };
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
        match adapter.inner.mouse_event(event, &lease) {
            Ok(_) => AdResult::Ok,
            Err(err) => {
                error::set_last_error(&err);
                error::last_error_code()
            }
        }
    })
}

#[cfg(test)]
#[path = "mouse_tests.rs"]
mod tests;
