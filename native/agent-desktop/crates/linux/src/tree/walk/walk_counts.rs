use agent_desktop_core::LocatorLimitStats;

use crate::tree::NodeClass;

/// What a walk met on the way: the limits it hit and the shape of the tree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct WalkCounts {
    pub(crate) limits: LocatorLimitStats,
    pub(crate) cycles_skipped: u64,
    pub(crate) wrapper_nodes: u64,
    pub(crate) max_logical_depth: usize,
    pub(crate) met_web_document: bool,
}

impl WalkCounts {
    pub(in crate::tree) fn note_node(&mut self, class: NodeClass, logical_depth: usize) {
        self.wrapper_nodes += u64::from(class.wrapper);
        self.met_web_document |= class.web_document;
        self.max_logical_depth = self.max_logical_depth.max(logical_depth);
    }

    pub(in crate::tree) fn note_hits(&mut self, hits: &LocatorLimitStats, cycles: u64) {
        self.limits.node_hits += hits.node_hits;
        self.limits.edge_hits += hits.edge_hits;
        self.limits.child_hits += hits.child_hits;
        self.cycles_skipped += cycles;
    }
}
