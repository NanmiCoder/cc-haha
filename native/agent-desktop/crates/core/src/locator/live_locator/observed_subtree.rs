use super::{LocatorEvidence, ObservationCompleteness};

pub struct ObservedSubtree {
    pub(crate) evidence: LocatorEvidence,
    pub(crate) children: Vec<Self>,
    pub(crate) completeness: ObservationCompleteness,
    pub(crate) children_count: Option<u32>,
    pub(crate) source_child_index: Option<usize>,
}

impl ObservedSubtree {
    pub fn new(
        evidence: LocatorEvidence,
        children: Vec<Self>,
        subtree_complete: bool,
        children_count: Option<u32>,
    ) -> Self {
        Self {
            evidence,
            children,
            completeness: ObservationCompleteness::new(subtree_complete),
            children_count,
            source_child_index: None,
        }
    }

    /// Preserves this node's index in its platform-native parent child list.
    pub fn with_source_child_index(mut self, source_child_index: usize) -> Self {
        self.source_child_index = Some(source_child_index);
        self
    }

    pub fn with_predecessors_complete(mut self, predecessors_complete: bool) -> Self {
        self.completeness.predecessors_complete = predecessors_complete;
        self
    }

    pub fn is_complete(&self) -> bool {
        self.completeness.subtree_complete
    }
}
