use agent_desktop_core::Deadline;

use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::registry_frames::{RootRead, read_frames};
use crate::system::{REGISTRY_ROOT_PATH, SharedBus};
use crate::tree::properties::toolkit_trust::reports_global_position;
use crate::tree::surfaces::top_level::is_top_level;
use crate::tree::vocabulary::state_bits::{SHOWING, StateBits};
use crate::tree::{AtspiElement, Extents, RawNode};

fn size(node: &RawNode) -> Option<(i32, i32)> {
    let bounds = node.extents.present()?;
    (bounds.width > 0 && bounds.height > 0 && bounds.x != i32::MIN && bounds.y != i32::MIN)
        .then_some((bounds.width, bounds.height))
}

/// An unnamed showing top-level without global positions may identify an X11
/// client by size only when no other top-level could claim that size. An unread
/// window size leaves the association unknown.
pub(crate) fn permits_size_match(
    node: &RawNode,
    siblings: &[RawNode],
    toolkit: &ToolkitId,
    expected: Option<Extents>,
) -> bool {
    let eligible = !reports_global_position(toolkit)
        && is_top_level(&node.traits.interfaces)
        && node.properties.name.present().is_some_and(String::is_empty)
        && node.traits.states.present().is_some_and(|words| {
            let bits = StateBits::new(words);
            bits.has(SHOWING)
        });
    let Some(target) = size(node).filter(|_| eligible) else {
        return false;
    };
    if expected.map(|bounds| (bounds.width, bounds.height)) != Some(target) {
        return false;
    }
    let mut matching = 0;
    for sibling in siblings {
        if sibling.traits.interfaces.is_failed() || sibling.traits.states.is_failed() {
            return false;
        }
        if is_top_level(&sibling.traits.interfaces) {
            let Some(other) = size(sibling) else {
                return false;
            };
            matching += usize::from(target == other);
        }
    }
    matching == 1
}

pub(crate) fn permits_on_bus(
    bus: &SharedBus,
    frame: &AtspiElement,
    toolkit: &ToolkitId,
    expected: Option<Extents>,
    deadline: Deadline,
) -> bool {
    if reports_global_position(toolkit) {
        return false;
    }
    let root = AtspiElement::new(frame.bus_name(), REGISTRY_ROOT_PATH, frame.pid());
    let Ok(mut apps) = read_frames(bus, &[root], deadline) else {
        return false;
    };
    let Some(app) = apps.pop().filter(|app| app.read == RootRead::Read) else {
        return false;
    };
    app.nodes
        .iter()
        .find(|node| node.element == *frame)
        .is_some_and(|node| permits_size_match(node, &app.nodes, toolkit, expected))
}

#[cfg(test)]
#[path = "frame_identity_tests.rs"]
mod tests;
