use super::chain_step::ChainStep;

pub(crate) struct ChainDef {
    pub(crate) steps: &'static [ChainStep],
    pub(crate) suggestion: &'static str,
    pub(crate) continue_after_unverified_delivery: bool,
}
