#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct NodeAttributeMetrics {
    pub(crate) batch_reads: u64,
    pub(crate) requested_count: u64,
    pub(crate) fallback_reads: u64,
    pub(crate) settable_reads: u64,
    pub(crate) deadline_exhausted: bool,
}
