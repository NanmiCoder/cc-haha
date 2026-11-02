use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub(crate) struct StabilityEvidence {
    pub(crate) samples: u32,
    pub(crate) span_ms: u64,
}
