use agent_desktop_core::adapter::live_element::incomplete_live_evidence;
use agent_desktop_core::{
    AdapterError, ElementState, LiveElement, LiveIdentity, LocatorEvidence, Rect, tree::state,
};

use crate::tree::placement::Placement;
#[cfg(test)]
use crate::tree::placement::visibility::{derived_offscreen, settled_by_read};
use crate::tree::placement::visibility::{is_sentinel, placed_states, pointer_extents};
use crate::tree::vocabulary::state_bits::StateBits;
use crate::tree::{Field, ObservedRead};

/// `ENABLED` or `SENSITIVE` (GTK4 sets only the second) makes a control
/// enabled, and so does `READ_ONLY` (Chromium sets neither bit on an enabled
/// read-only input); a successful state read with none of them makes it
/// disabled.
fn enabled(read: &ObservedRead) -> Option<bool> {
    read.node
        .traits
        .states
        .present()
        .map(|words| !StateBits::new(words).is_disabled())
}

fn secure(evidence: &LocatorEvidence) -> bool {
    evidence
        .states
        .known()
        .is_none_or(|tokens| tokens.iter().any(|token| token == state::SECURE))
}

/// The node's value, withheld from a secure field whatever was read.
pub(crate) fn live_value(evidence: &LocatorEvidence) -> Result<Option<String>, AdapterError> {
    if secure(evidence) {
        return Ok(None);
    }
    if evidence.value.is_unknown() {
        return Err(incomplete_live_evidence());
    }
    Ok(evidence.value.known().cloned())
}

/// The node's rectangle in the frame a pointer is aimed in, for a toolkit
/// whose own screen extents cannot be trusted: the toolkit's rule applied to
/// the screen extents, the window extents and the client origin. `None` when
/// nothing was read or the position cannot be proved.
pub(crate) fn pointer_rect(read: &ObservedRead, placement: &Placement) -> Option<Rect> {
    pointer_extents(read, placement).map(Rect::from)
}

/// The state projection. `hidden` and `offscreen` follow
/// the placement: the token and `Some(true)` together on positive evidence.
pub(crate) fn live_state(
    read: &ObservedRead,
    evidence: &LocatorEvidence,
    placement: &Placement,
) -> Result<ElementState, AdapterError> {
    let role = evidence
        .role
        .known()
        .cloned()
        .ok_or_else(incomplete_live_evidence)?;
    let projected = placed_states(read, evidence, placement)?;
    Ok(ElementState {
        role,
        states: projected.states,
        value: live_value(evidence)?,
        enabled: enabled(read),
        hidden: projected.hidden,
        offscreen: projected.offscreen,
    })
}

pub(crate) fn live_actions(evidence: &LocatorEvidence) -> Result<Vec<String>, AdapterError> {
    match &evidence.ref_evidence.available_actions {
        agent_desktop_core::LocatorField::Known(actions) => Ok(actions.clone()),
        agent_desktop_core::LocatorField::Absent => Ok(Vec::new()),
        agent_desktop_core::LocatorField::Unknown => Err(incomplete_live_evidence()),
    }
}

/// The node's extents as the toolkit reports them. Zero and `-1` extents are
/// values. The position `INT32_MIN` a toolkit gives a node off every screen is
/// no bounds, and so is a node without a `Component` interface or one whose
/// extents could not be read.
pub(crate) fn live_bounds(read: &ObservedRead) -> Option<Rect> {
    match &read.node.extents {
        Field::Present(extents) if !is_sentinel(*extents) => Some(Rect::from(*extents)),
        Field::Present(_) | Field::Absent | Field::Failed(_) => None,
    }
}

/// Identity, state, bounds and actions of one node, all from the one read.
/// A toolkit whose screen extents are global keeps them; any other takes the
/// provable pointer rectangle and has no bounds when none can be proved,
/// because its own position is `[0, 0]`.
pub(crate) fn live_element(
    read: &ObservedRead,
    evidence: &LocatorEvidence,
    placement: &Placement,
    global: bool,
) -> Result<LiveElement, AdapterError> {
    let mut available_actions = live_actions(evidence)?;
    if read.node.actions.present().is_some_and(|names| {
        crate::tree::capabilities::action_names::unsupported_entry_activation(
            read.node.traits.role.present().copied(),
            names,
            &placement.toolkit,
        )
    }) {
        available_actions.retain(|action| action != "Click");
    }
    let bounds = if global {
        live_bounds(read)
    } else {
        pointer_rect(read, placement)
    };
    Ok(LiveElement {
        identity: LiveIdentity {
            name: evidence.name.clone(),
            description: evidence.description.clone(),
            identifiers: evidence.identifiers.clone(),
        },
        state: live_state(read, evidence, placement)?,
        states_complete: true,
        bounds,
        available_actions,
    })
}

#[cfg(test)]
#[path = "live_project_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "live_placement_tests.rs"]
mod placement_tests;

#[cfg(test)]
#[path = "clipped_row_tests.rs"]
mod clipped_row_tests;

#[cfg(test)]
#[path = "live_tie_tests.rs"]
mod tie_tests;
