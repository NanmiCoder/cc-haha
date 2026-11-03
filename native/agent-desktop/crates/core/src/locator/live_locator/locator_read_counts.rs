use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocatorReadCounts {
    pub observation_attempts: u64,
    pub attribute_batches: u64,
    pub attributes_requested: u64,
    pub child_reads: u64,
    pub action_reads: u64,
    pub fallback_reads: u64,
}
