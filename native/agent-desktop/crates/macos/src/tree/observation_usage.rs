use agent_desktop_core::ObservationBudget;

pub(crate) struct ObservationUsage {
    limits: ObservationBudget,
    nodes: usize,
    edges: usize,
    text_bytes: usize,
}

impl ObservationUsage {
    pub(crate) fn with_defaults() -> Self {
        Self::new(ObservationBudget::default())
    }

    pub(crate) fn new(limits: ObservationBudget) -> Self {
        Self {
            limits,
            nodes: 0,
            edges: 0,
            text_bytes: 0,
        }
    }

    pub(crate) fn claim_node(&mut self) -> bool {
        if self.nodes >= self.limits.max_nodes {
            return false;
        }
        self.nodes += 1;
        true
    }

    pub(crate) fn child_capacity(&self) -> usize {
        self.limits
            .max_children_per_node
            .min(self.limits.max_edges.saturating_sub(self.edges))
            .min(self.limits.max_nodes.saturating_sub(self.nodes))
    }

    pub(crate) fn claim_edges(&mut self, count: usize) {
        self.edges = self.edges.saturating_add(count).min(self.limits.max_edges);
    }

    pub(crate) fn note_child_demand(
        &self,
        total_count: usize,
        stats: &mut agent_desktop_core::LocatorStats,
    ) {
        if total_count > self.limits.max_children_per_node {
            stats.traversal.limits.child_hits += 1;
        }
        if total_count > self.limits.max_edges.saturating_sub(self.edges) {
            stats.traversal.limits.edge_hits += 1;
        }
        if total_count > self.limits.max_nodes.saturating_sub(self.nodes) {
            stats.traversal.limits.node_hits += 1;
        }
    }

    pub(crate) fn string_capacity(&self) -> usize {
        self.limits
            .max_field_bytes
            .min(self.limits.max_text_bytes.saturating_sub(self.text_bytes))
    }

    pub(crate) fn claim_text(&mut self, bytes: usize) {
        self.text_bytes = self
            .text_bytes
            .saturating_add(bytes)
            .min(self.limits.max_text_bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> ObservationBudget {
        ObservationBudget {
            max_nodes: 3,
            max_edges: 2,
            max_children_per_node: 4,
            max_field_bytes: 5,
            max_text_bytes: 7,
        }
    }

    #[test]
    fn node_edge_and_text_capacities_share_one_observation_budget() {
        let mut usage = ObservationUsage::new(limits());

        assert!(usage.claim_node());
        assert_eq!(usage.child_capacity(), 2);
        usage.claim_edges(2);
        assert_eq!(usage.child_capacity(), 0);
        assert_eq!(usage.string_capacity(), 5);
        usage.claim_text(5);
        assert_eq!(usage.string_capacity(), 2);
    }
}
