use agent_desktop_core::{LocatorEvidence, ObservedSubtree};

use crate::tree::{ObservedRead, WalkedNode};

/// A hook a caller gives the projection to add what the accessibility tree
/// does not carry: it sees the finished walk once, may change the evidence of
/// each node as it is projected, and may append nodes of its own. The
/// default does nothing, which is what an ordinary observation uses.
pub(crate) trait Decorate {
    fn prepare(&mut self, _root: &WalkedNode<ObservedRead>) {}

    /// Called once per node in document order, before its children are
    /// projected. The returned nodes are appended after the node's own
    /// children, which end before `first_child_index`.
    fn decorate(
        &mut self,
        _read: &ObservedRead,
        _evidence: &mut LocatorEvidence,
        _first_child_index: usize,
    ) -> Vec<ObservedSubtree> {
        Vec::new()
    }

    /// Nodes appended to the root of the observation after everything else.
    fn finish(&mut self, _first_child_index: usize) -> Vec<ObservedSubtree> {
        Vec::new()
    }
}

pub(crate) struct Plain;

impl Decorate for Plain {}

#[cfg(test)]
#[path = "decorate_tests.rs"]
mod tests;
