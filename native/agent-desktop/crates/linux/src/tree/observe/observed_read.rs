use crate::tree::capabilities::value_read::ValueRead;
use crate::tree::{AtspiElement, LabelOutcome, RawNode};

/// Everything read for one node of an observation: the raw node, the text of
/// its label when its name is blank, and its value when its role carries one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ObservedRead {
    pub(crate) node: RawNode,
    pub(crate) label: LabelOutcome,
    pub(crate) value: ValueRead,
    /// The rectangle a ref can store as evidence and the frame it is measured
    /// in, when the node's own screen rectangle is not provable. `None` means
    /// the node's own extents are screen evidence.
    pub(crate) evidence_bounds: Option<(crate::tree::Extents, agent_desktop_core::BoundsSpace)>,
}

impl ObservedRead {
    /// A node whose every read failed, kept in place so the walk can go on.
    pub(crate) fn unreadable(element: AtspiElement, detail: &str) -> Self {
        Self {
            node: RawNode::unreadable(element, detail),
            label: LabelOutcome::Unlabelled,
            value: ValueRead::absent(),
            evidence_bounds: None,
        }
    }

    /// A node read without a label or a value.
    #[cfg(test)]
    pub(crate) fn plain(node: RawNode) -> Self {
        Self {
            node,
            label: LabelOutcome::Unlabelled,
            value: ValueRead::absent(),
            evidence_bounds: None,
        }
    }
}
