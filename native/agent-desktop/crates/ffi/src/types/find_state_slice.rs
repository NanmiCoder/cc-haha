use crate::types::AdFindStatePredicate;

#[repr(C)]
pub struct AdFindStateSlice {
    pub items: *const AdFindStatePredicate,
    pub count: usize,
}

pub const AD_FIND_STATE_SLICE_SIZE: usize = 16;

const _: () = assert!(std::mem::size_of::<AdFindStateSlice>() == AD_FIND_STATE_SLICE_SIZE);
