use super::{
    LocatorActivationStats, LocatorEvaluationStats, LocatorIdentifierStats, LocatorReadStats,
    LocatorSemanticReadStats, LocatorTraversalStats,
};
use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocatorStats {
    pub activation: LocatorActivationStats,
    pub traversal: LocatorTraversalStats,
    pub reads: LocatorReadStats,
    pub identifiers: LocatorIdentifierStats,
    pub semantic_reads: LocatorSemanticReadStats,
    pub evaluation: LocatorEvaluationStats,
    pub elapsed_us: u64,
}

impl LocatorStats {
    pub(crate) fn merge_observation(&mut self, other: &Self) {
        self.activation.attempted |= other.activation.attempted;
        self.activation.succeeded |= other.activation.succeeded;
        self.activation.ready |= other.activation.ready;
        self.traversal.nodes_visited += other.traversal.nodes_visited;
        self.traversal.peak_handles_owned = self
            .traversal
            .peak_handles_owned
            .max(other.traversal.peak_handles_owned);
        self.traversal.max_raw_depth = self
            .traversal
            .max_raw_depth
            .max(other.traversal.max_raw_depth);
        self.traversal.max_logical_depth = self
            .traversal
            .max_logical_depth
            .max(other.traversal.max_logical_depth);
        self.traversal.web_wrapper_nodes += other.traversal.web_wrapper_nodes;
        self.traversal.cycles_skipped += other.traversal.cycles_skipped;
        self.traversal.limits.merge(&other.traversal.limits);
        self.reads.counts.observation_attempts += other.reads.counts.observation_attempts;
        self.reads.counts.attribute_batches += other.reads.counts.attribute_batches;
        self.reads.counts.attributes_requested += other.reads.counts.attributes_requested;
        self.reads.counts.child_reads += other.reads.counts.child_reads;
        self.reads.counts.action_reads += other.reads.counts.action_reads;
        self.reads.counts.fallback_reads += other.reads.counts.fallback_reads;
        self.reads.health.cannot_complete += other.reads.health.cannot_complete;
        self.reads.health.native_read_failures += other.reads.health.native_read_failures;
        self.reads.health.deadline_exhausted += other.reads.health.deadline_exhausted;
        self.identifiers.values_observed += other.identifiers.values_observed;
        self.identifiers.nodes_with_identifiers += other.identifiers.nodes_with_identifiers;
        self.identifiers.nodes_with_multiple_identifiers +=
            other.identifiers.nodes_with_multiple_identifiers;
        self.semantic_reads.child_label_reads += other.semantic_reads.child_label_reads;
        self.semantic_reads.promotion_reads += other.semantic_reads.promotion_reads;
        self.semantic_reads.settable_reads += other.semantic_reads.settable_reads;
    }

    pub(crate) fn merge_attempt(&mut self, other: &Self) {
        self.merge_observation(other);
        self.merge_evaluation(other);
    }

    pub(crate) fn merge_evaluation(&mut self, other: &Self) {
        self.identifiers.preferred_matches += other.identifiers.preferred_matches;
        self.identifiers.fallback_matches += other.identifiers.fallback_matches;
        self.evaluation.query_clause_count = self
            .evaluation
            .query_clause_count
            .max(other.evaluation.query_clause_count);
        self.evaluation.text_clause_count = self
            .evaluation
            .text_clause_count
            .max(other.evaluation.text_clause_count);
        self.evaluation.memo_cells_evaluated += other.evaluation.memo_cells_evaluated;
        self.evaluation.self_filter_candidates += other.evaluation.self_filter_candidates;
        self.evaluation.matched_nodes += other.evaluation.matched_nodes;
    }
}
