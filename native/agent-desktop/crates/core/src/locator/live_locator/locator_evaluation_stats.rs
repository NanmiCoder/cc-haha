use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocatorEvaluationStats {
    pub query_clause_count: u32,
    pub text_clause_count: u32,
    pub memo_cells_evaluated: u64,
    pub self_filter_candidates: u64,
    pub matched_nodes: u64,
}
