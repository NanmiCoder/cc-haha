use super::Placement;
use super::display_bounds::off_every_display;
use super::frame_geometry::pointer_bounds;
use super::offscreen::{OffscreenInput, offscreen};
use super::placed_states::PlacedStates;
use crate::tree::properties::toolkit_trust::reports_global_position;
use crate::tree::vocabulary::state_bits::{SHOWING, StateBits, VISIBLE};
use crate::tree::{Extents, Field, ObservedRead};
use agent_desktop_core::adapter::live_element::incomplete_live_evidence;
use agent_desktop_core::{AdapterError, LocatorEvidence, tree::state};

pub(crate) fn is_sentinel(rect: Extents) -> bool {
    rect.x == i32::MIN || rect.y == i32::MIN
}

pub(crate) fn is_placed(rect: Extents) -> bool {
    !is_sentinel(rect) && rect.width > 0 && rect.height > 0
}

/// L6-9: VISIBLE without SHOWING at INT32_MIN is not drawn.
pub(crate) fn not_drawn(visible: bool, showing: bool, sentinel: bool) -> bool {
    visible && !showing && sentinel
}

/// Whether a state read succeeded and neither `VISIBLE` nor `SHOWING` is set.
/// `SHOWING` alone cannot decide it: on-screen Chromium and Gecko nodes report
/// `VISIBLE` without `SHOWING` (L3-27), and `SHOWING` is a strict subset of
/// `VISIBLE` (L3-7).
fn is_hidden(read: &ObservedRead) -> bool {
    state_bits(read) == Some((false, false))
}

fn state_bits(read: &ObservedRead) -> Option<(bool, bool)> {
    read.node.traits.states.present().map(|words| {
        let bits = StateBits::new(words);
        (bits.has(VISIBLE), bits.has(SHOWING))
    })
}

/// Whether the one node read already settles offscreen without looking at the
/// window: the state set failed, or it has the GTK 3 shape of a row scrolled out of its viewport (`VISIBLE` without `SHOWING`
/// at the sentinel position, L6-9).
pub(crate) fn settled_by_read(read: &ObservedRead) -> bool {
    match state_bits(read) {
        None => true,
        Some((visible, showing)) => not_drawn(
            visible,
            showing,
            read.node
                .extents
                .present()
                .copied()
                .is_some_and(is_sentinel),
        ),
    }
}

/// `Some(true)` only on positive evidence, `Some(false)` only when the node
/// provably intersects its frame with its centre inside its scroll container
/// in a window that is not minimized, `None` when anything needed was not read. A node with neither
/// `VISIBLE` nor `SHOWING` is hidden, which is its own evidence: it can still
/// be off screen on a rectangle outside its window (a Qt item scrolled out of
/// view reads that way, L27-6), but it is never called on screen.
pub(crate) fn derived_offscreen(read: &ObservedRead, placement: &Placement) -> Option<bool> {
    let (visible, showing) = state_bits(read)?;
    let hidden = is_hidden(read);
    let minimized =
        if placement.frame_iconified == Some(true) || placement.x11.is_some_and(|x11| x11.hidden) {
            Some(true)
        } else if placement.popup_origin.is_some() {
            Some(false)
        } else {
            placement
                .x11
                .map(|_| false)
                .or_else(|| placement.tie.and_then(|tie| tie.hidden))
        };
    let verdict = offscreen(OffscreenInput {
        node: placement.node,
        frame: placement.frame,
        container: placement.container,
        visible,
        showing,
        sentinel: read
            .node
            .extents
            .present()
            .copied()
            .is_some_and(is_sentinel),
        minimized,
    });
    let container_unread =
        read.node.element.scroll_container().is_some() && placement.container.is_none();
    let centre_clipped = read.node.element.scroll_container().is_some()
        && placement
            .node
            .zip(placement.container)
            .is_some_and(|(node, container)| {
                crate::tree::hit_test::hit_guard::aimable(node)
                    && crate::tree::hit_test::hit_guard::aimable(container)
                    && node
                        .x
                        .checked_add(node.width / 2)
                        .zip(node.y.checked_add(node.height / 2))
                        .is_some_and(|point| {
                            !crate::tree::hit_test::hit_guard::admits(container, point)
                        })
            });
    let off_screen = verdict != Some(true)
        && off_every_display(screen_rect(read, placement), placement.displays.as_deref());
    match verdict {
        _ if off_screen || centre_clipped => Some(true),
        Some(false) if container_unread || hidden => None,
        other => other,
    }
}

/// The node's rectangle in screen coordinates: the toolkit's own extents when
/// it reports global positions, the provable pointer rectangle otherwise.
fn screen_rect(read: &ObservedRead, placement: &Placement) -> Option<Extents> {
    if reports_global_position(&placement.toolkit) {
        return match &read.node.extents {
            Field::Present(extents) => Some(*extents),
            Field::Absent | Field::Failed(_) => None,
        };
    }
    pointer_extents(read, placement)
}

pub(crate) fn pointer_extents(read: &ObservedRead, placement: &Placement) -> Option<Extents> {
    let Field::Present(screen) = &read.node.extents else {
        return None;
    };
    let window: Extents = placement.node?;
    let origin = placement.popup_origin.or_else(|| {
        placement.x11.and_then(|x11| {
            Some((
                x11.client_origin.0.checked_add(x11.shadow.0)?,
                x11.client_origin.1.checked_add(x11.shadow.1)?,
            ))
        })
    });
    pointer_bounds(&placement.toolkit, *screen, window, origin)
}

/// Whether a node that both `VISIBLE` and `SHOWING` sit on a frame that is not
/// iconified, in a Wayland session whose toolkit reports no global position:
/// there is no rectangle to prove it on screen, but the toolkit's own flags
/// say it is mapped and shown, and that is all that is claimed.
fn on_a_mapped_wayland_frame(read: &ObservedRead, placement: &Placement) -> bool {
    placement.wayland_unplaced
        && placement.x11.is_none()
        && placement.frame.is_some()
        && placement.frame_iconified == Some(false)
        && state_bits(read) == Some((true, true))
}

/// State tokens and placement facts shared by getters and pointer evidence.
pub(in crate::tree) fn placed_states(
    read: &ObservedRead,
    evidence: &LocatorEvidence,
    placement: &Placement,
) -> Result<PlacedStates, AdapterError> {
    let mut states = evidence
        .states
        .known()
        .cloned()
        .ok_or_else(incomplete_live_evidence)?;
    if is_hidden(read) && !states.iter().any(|token| token == state::HIDDEN) {
        states.push(state::HIDDEN.to_owned());
    }
    let off = derived_offscreen(read, placement);
    let mapped = off.is_none() && on_a_mapped_wayland_frame(read, placement);
    let off = if mapped { Some(false) } else { off };
    if off == Some(true) && !states.iter().any(|token| token == state::OFFSCREEN) {
        states.push(state::OFFSCREEN.to_owned());
    }
    Ok(PlacedStates {
        states,
        hidden: mapped.then_some(false),
        offscreen: off,
    })
}
