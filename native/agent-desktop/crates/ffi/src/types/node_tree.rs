use crate::types::node::AdNode;

#[repr(C)]
pub struct AdNodeTree {
    pub nodes: *mut AdNode,
    pub count: u32,
}
