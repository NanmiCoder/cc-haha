#[repr(C)]
pub struct AdNodeRelation {
    pub parent_index: i32,
    pub child_start: u32,
    pub child_count: u32,
}

pub const AD_NODE_RELATION_SIZE: usize = 12;

const _: () = assert!(std::mem::size_of::<AdNodeRelation>() == AD_NODE_RELATION_SIZE);
