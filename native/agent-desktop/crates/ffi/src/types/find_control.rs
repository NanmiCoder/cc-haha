use crate::types::AdFindSelection;

#[repr(C)]
pub struct AdFindControl {
    pub version: u32,
    pub selection: AdFindSelection,
    pub timeout_ms: u64,
}

pub const AD_FIND_CONTROL_SIZE: usize = 24;

const _: () = assert!(std::mem::size_of::<AdFindControl>() == AD_FIND_CONTROL_SIZE);
