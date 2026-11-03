use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub(crate) struct HitTestEvidence {
    pub(crate) attempted: u8,
    pub(crate) unknown: u8,
    pub(crate) occluded: u8,
}
