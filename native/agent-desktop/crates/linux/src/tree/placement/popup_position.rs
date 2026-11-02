use agent_desktop_core::{AdapterError, Deadline, NativeHandle};

use crate::tree::atspi_element;
use crate::tree::live_read::live_project::{live_bounds, pointer_rect};
use crate::tree::live_read::{NodeReader, read_live};

/// What a search for the screen position of a popup item found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PopupPosition {
    Placed,
    /// The popup's window and the item's place in it were read, and no
    /// viewable window answers for the popup: it is closed.
    Unmapped,
    /// Nothing places this popup, or what places it could not be read, so the
    /// lack of a position says nothing about whether it is open.
    Unplaceable,
}

/// Looks once for the screen position of a popup item.
pub(crate) fn popup_position_via<R: NodeReader>(
    reader: &mut R,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<PopupPosition, AdapterError> {
    let node = read_live(reader, handle)?;
    let element = atspi_element(handle)?;
    if reader.global_position(element, deadline) {
        return Ok(if live_bounds(&node.read).is_some() {
            PopupPosition::Placed
        } else {
            PopupPosition::Unplaceable
        });
    }
    let placed = reader.placement(element, deadline);
    let unread = placed.node.is_none() || placed.frame.is_none();
    Ok(match pointer_rect(&node.read, &placed) {
        Some(_) => PopupPosition::Placed,
        None if placed.wayland_unplaced || unread => PopupPosition::Unplaceable,
        None => PopupPosition::Unmapped,
    })
}

#[cfg(test)]
#[path = "popup_position_tests.rs"]
mod tests;
