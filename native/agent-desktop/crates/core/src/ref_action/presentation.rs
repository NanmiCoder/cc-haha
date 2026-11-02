use std::cell::Cell;

use super::{ActionabilityPreflight, ResolvedRefAction};
use crate::cursor_overlay::CursorPhase;
use crate::{Action, CommandContext, PlatformAdapter};

const SAME_POINT: f64 = 1.5;
const FOCUS_READ_MS: u64 = 150;

thread_local! {
    static TRAVELLED_BEFORE_LEASE: Cell<Option<(f64, f64)>> = const { Cell::new(None) };
}

pub(super) fn before_dispatch(
    target: &ResolvedRefAction<'_>,
    preflight: &ActionabilityPreflight,
    action: &Action,
    lease: &crate::InteractionLease,
) {
    let Some(destination) = destination(preflight) else {
        return;
    };
    let travelled = TRAVELLED_BEFORE_LEASE.get();
    if travelled.is_some_and(|(x, y)| (destination.x - x).hypot(destination.y - y) < SAME_POINT) {
        return;
    }
    TRAVELLED_BEFORE_LEASE.set(None);
    let pointer = shows_pointer(&target.entry.identity.role, action);
    crate::cursor_overlay::submit_travel(
        target.adapter,
        target.context,
        destination,
        lease,
        pointer,
    );
}

/// Starts the drawn cursor's travel toward the target before the interaction
/// lease is taken, from a read-only resolution of the element. Whatever this
/// observes is re-resolved under the lease before dispatch, so it only decides
/// where the cursor heads. Headed actions keep their travel under the lease,
/// because they move the real pointer. `holds_cursor` says no other command
/// can move this cursor until the action's effect has played (see
/// `cursor_overlay::hold_cursor`); without it the travel waits for the lease.
pub(super) fn before_lease(
    context: super::ref_action_wait_context::RefActionWaitContext<'_>,
    request: &crate::ActionRequest,
    deadline: crate::Deadline,
    holds_cursor: bool,
) {
    TRAVELLED_BEFORE_LEASE.set(None);
    if !holds_cursor || request.policy.is_headed() || !context.context.cursor_overlay().is_enabled()
    {
        return;
    }
    let Some(destination) = target_center(context, deadline) else {
        return;
    };
    let pointer = shows_pointer(&context.entry.identity.role, &request.action);
    if crate::cursor_overlay::submit_travel_before_lease(
        context.adapter,
        context.context,
        destination.clone(),
        deadline,
        pointer,
    ) {
        TRAVELLED_BEFORE_LEASE.set(Some((destination.x, destination.y)));
    }
}

fn target_center(
    context: super::ref_action_wait_context::RefActionWaitContext<'_>,
    deadline: crate::Deadline,
) -> Option<crate::Point> {
    let geometry = &context.entry.geometry;
    let stored = matches!(
        geometry.bounds_space,
        None | Some(crate::BoundsSpace::Screen)
    )
    .then_some(geometry.bounds.as_ref())
    .flatten()
    .and_then(center_of);
    stored.or_else(|| {
        let handle = context
            .adapter
            .resolve_element_strict(context.entry, deadline)
            .ok()?;
        let bounds = context
            .adapter
            .get_element_bounds(&handle, deadline)
            .ok()
            .flatten()?;
        center_of(&bounds)
    })
}

pub(crate) fn enters_text(action: &Action) -> bool {
    matches!(action, Action::TypeText(_) | Action::SetValue(_))
}

/// Whether the effect after dispatch plays the click ripple. Typing plays it
/// only when it has to click into its field: a field that already has
/// keyboard focus is typed into where it is. That costs one live-state read,
/// made only for typing with the overlay on; an element whose state cannot be
/// read is treated as unfocused, so typing into it ripples.
pub(super) fn effect_ripples(target: &ResolvedRefAction<'_>, action: &Action) -> bool {
    if is_click(action) {
        return true;
    }
    if !matches!(action, Action::TypeText(_)) || !target.context.cursor_overlay().is_enabled() {
        return false;
    }
    let deadline = target
        .deadline
        .capped(std::time::Duration::from_millis(FOCUS_READ_MS));
    let focused = target
        .adapter
        .get_live_state(target.handle, deadline)
        .ok()
        .flatten()
        .is_some_and(|state| {
            crate::tree::state::has_state(&state.states, crate::tree::state::FOCUSED)
        });
    !focused
}

fn center_of(bounds: &crate::Rect) -> Option<crate::Point> {
    bounds.validate().ok()?;
    (bounds.width > 0.0 && bounds.height > 0.0).then(|| crate::Point {
        x: bounds.x + bounds.width / 2.0,
        y: bounds.y + bounds.height / 2.0,
    })
}

/// A pressable control shows the pointer however it is reached; any other element shows it
/// only when clicked, and text entry never does.
pub(super) fn shows_pointer(role: &str, action: &Action) -> bool {
    let role = crate::Role::from_token(role);
    role.is_pressable() || (is_click(action) && !role.takes_text())
}

pub(super) fn after_dispatch(
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
    preflight: &ActionabilityPreflight,
    ripples: bool,
    result: &Result<crate::ActionResult, crate::AdapterError>,
) {
    let disposition = match result {
        Ok(result) => result.disposition(),
        Err(error) => error.disposition,
    };
    let travelled = TRAVELLED_BEFORE_LEASE.take();
    if !crate::cursor_overlay::confirms_delivery(disposition) {
        return;
    }
    let Some(destination) = travelled
        .map(|(x, y)| crate::Point { x, y })
        .or_else(|| destination(preflight))
    else {
        return;
    };
    crate::cursor_overlay::submit(
        adapter,
        context,
        destination,
        preflight.presentation_bounds,
        ripples,
        CursorPhase::Effect,
    );
}

/// After text entry lands, draws the agent's caret where the element is now
/// inserting text, when the element reports an insertion point. Returns
/// whether it did: the caret then marks the field, so the element outline is
/// left off rather than flashing on every keystroke.
pub(super) fn after_text_entry(
    target: &ResolvedRefAction<'_>,
    action: &Action,
    result: &Result<crate::ActionResult, crate::AdapterError>,
) -> bool {
    let delivered = match result {
        Ok(result) => crate::cursor_overlay::confirms_delivery(result.disposition()),
        Err(error) => crate::cursor_overlay::confirms_delivery(error.disposition),
    };
    delivered && enters_text(action) && place_caret(target.adapter, target.context, target.handle)
}

fn place_caret(
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
    handle: &crate::NativeHandle,
) -> bool {
    if !context.cursor_overlay().is_enabled() {
        return false;
    }
    let Ok(deadline) = crate::Deadline::after(crate::CURSOR_ARRIVAL_TIMEOUT_MS) else {
        return false;
    };
    let Ok(Some(caret)) = adapter.get_insertion_caret(handle, deadline) else {
        return false;
    };
    crate::cursor_overlay::submit_caret(adapter, context, caret);
    true
}

/// Moves the agent's caret to the element's insertion point during a typing
/// burst. The cursor stays where it clicked into the field, the way a person's
/// pointer stays put while they type.
pub(crate) fn move_caret(
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
    handle: &crate::NativeHandle,
) {
    place_caret(adapter, context, handle);
}

fn destination(preflight: &ActionabilityPreflight) -> Option<crate::Point> {
    match preflight.pointer_delivery {
        crate::actionability::PointerDelivery::Physical => preflight
            .verified_point
            .clone()
            .or_else(|| preflight.presentation_point.clone()),
        _ => preflight.presentation_point.clone(),
    }
}

fn is_click(action: &Action) -> bool {
    matches!(
        action,
        Action::Click | Action::DoubleClick | Action::RightClick | Action::TripleClick
    )
}

#[cfg(test)]
#[path = "presentation_tests.rs"]
mod tests;
