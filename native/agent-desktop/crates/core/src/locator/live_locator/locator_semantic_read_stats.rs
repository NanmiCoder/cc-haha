use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocatorSemanticReadStats {
    pub child_label_reads: u64,
    pub promotion_reads: u64,
    pub settable_reads: u64,
}
