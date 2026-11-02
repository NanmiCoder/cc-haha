use crate::refs::RefPath;

use super::{LocatorEvidence, ObservationCompleteness};

#[derive(Debug, Clone)]
pub struct ObservedNode {
    pub(crate) evidence: LocatorEvidence,
    pub(crate) path: RefPath,
    pub(crate) children: Vec<u32>,
    pub(crate) document_order: u32,
    pub(crate) completeness: ObservationCompleteness,
    pub(crate) children_count: Option<u32>,
    pub(crate) ref_id: Option<String>,
}
