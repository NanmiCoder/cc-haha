use crate::types::{AdNodeContent, AdNodePresentation, AdNodeRelation};

#[repr(C)]
pub struct AdNode {
    pub content: AdNodeContent,
    pub presentation: AdNodePresentation,
    pub relation: AdNodeRelation,
}

pub const AD_NODE_SIZE: usize = 112;

const _: () = assert!(std::mem::size_of::<AdNode>() == AD_NODE_SIZE);
