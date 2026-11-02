use super::{LocatorStats, match_verdict::MatchVerdict};

pub(crate) struct EvaluationBuffers<'a> {
    pub matches: &'a mut [MatchVerdict],
    pub subtree_matches: &'a mut [MatchVerdict],
    pub subtree_text: &'a mut [MatchVerdict],
    pub stats: &'a mut LocatorStats,
}
