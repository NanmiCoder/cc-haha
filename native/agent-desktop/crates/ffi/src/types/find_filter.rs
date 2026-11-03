use crate::types::{AdFindIdentity, AdFindQuery, AdFindStateSlice};
use std::os::raw::c_char;

#[repr(C)]
pub struct AdFindFilter {
    pub identity: AdFindIdentity,
    pub has_text: *const c_char,
    pub states: AdFindStateSlice,
    pub has: *const AdFindQuery,
    pub has_not: *const AdFindQuery,
    pub exact: bool,
}

pub const AD_FIND_FILTER_SIZE: usize = 88;

const _: () = assert!(std::mem::size_of::<AdFindFilter>() == AD_FIND_FILTER_SIZE);
