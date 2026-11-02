use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocatorLimitStats {
    pub node_hits: u64,
    pub edge_hits: u64,
    pub child_hits: u64,
    pub child_label_hits: u64,
    pub text_hits: u64,
    pub depth_hits: u64,
    pub child_count_changes: u64,
}

impl LocatorLimitStats {
    pub(crate) fn merge(&mut self, other: &Self) {
        self.node_hits += other.node_hits;
        self.edge_hits += other.edge_hits;
        self.child_hits += other.child_hits;
        self.child_label_hits += other.child_label_hits;
        self.text_hits += other.text_hits;
        self.depth_hits += other.depth_hits;
        self.child_count_changes += other.child_count_changes;
    }
}
