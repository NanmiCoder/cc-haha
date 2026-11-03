use std::collections::HashMap;

use agent_desktop_core::LocatorEvidence;

use super::Placement;
use super::visibility::placed_states;
use crate::tree::vocabulary::state_bits::{ICONIFIED, StateBits};
use crate::tree::{AtspiElement, Extents, ObservedRead, WalkedNode};

/// Geometry has already passed the toolkit trust rule in node_position.
/// Window evidence is retained even when no global position could be proved.
fn rectangle(read: &ObservedRead) -> Option<Extents> {
    read.evidence_bounds
        .map(|(rect, _)| rect)
        .or_else(|| read.node.extents.present().copied())
}

pub(crate) struct SnapshotVisibility<'a> {
    displays: Option<&'a [Extents]>,
    reads: HashMap<(String, String), (Option<Extents>, Option<bool>)>,
}

impl<'a> SnapshotVisibility<'a> {
    pub(crate) fn new(root: &WalkedNode<ObservedRead>, displays: Option<&'a [Extents]>) -> Self {
        let mut reads = HashMap::new();
        let mut pending = vec![root];
        while let Some(node) = pending.pop() {
            let element = &node.payload.node.element;
            reads.insert(
                (element.bus_name().to_owned(), element.path().to_owned()),
                (
                    rectangle(&node.payload),
                    node.payload
                        .node
                        .traits
                        .states
                        .present()
                        .map(|words| StateBits::new(words).has(ICONIFIED)),
                ),
            );
            pending.extend(&node.children);
        }
        Self { reads, displays }
    }

    fn read(&self, element: &AtspiElement) -> Option<(Option<Extents>, Option<bool>)> {
        self.reads
            .get(&(element.bus_name().to_owned(), element.path().to_owned()))
            .copied()
    }

    pub(crate) fn append(&self, read: &ObservedRead, evidence: &mut LocatorEvidence) {
        append_visibility(read, evidence, &self.placement(read));
        if super::display_bounds::off_every_display(
            read.node.extents.present().copied(),
            self.displays,
        ) && let Some(states) = evidence.states.known().cloned()
        {
            let mut states = states;
            if !states
                .iter()
                .any(|state| state == agent_desktop_core::tree::state::OFFSCREEN)
            {
                states.push(agent_desktop_core::tree::state::OFFSCREEN.to_owned());
            }
            evidence.states = agent_desktop_core::LocatorField::Known(states);
        }
    }

    /// L41-18: popup descendants can lie outside their menu-bar anchor rectangle.
    pub(crate) fn placement(&self, read: &ObservedRead) -> Placement {
        let frame = read.node.element.frame().and_then(|frame| self.read(frame));
        let in_menu = !read.node.element.ancestry().menu_ancestors().is_empty();
        Placement {
            node: rectangle(read),
            frame: frame.and_then(|(rect, _)| rect).filter(|_| !in_menu),
            container: read
                .node
                .element
                .scroll_container()
                .and_then(|container| self.read(container))
                .and_then(|(rect, _)| rect),
            frame_iconified: frame.and_then(|(_, iconified)| iconified),
            ..Placement::default()
        }
    }
}

pub(crate) fn append_visibility(
    read: &ObservedRead,
    evidence: &mut LocatorEvidence,
    placement: &Placement,
) {
    if let Ok(projected) = placed_states(read, evidence, placement) {
        evidence.states = agent_desktop_core::LocatorField::Known(projected.states);
    }
}
