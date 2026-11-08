use crate::types::AdOptionalUsize;
use std::os::raw::c_char;

#[repr(C)]
pub struct AdWaitPredicate {
    pub predicate: *const c_char,
    pub value: *const c_char,
    pub action: *const c_char,
    pub count: AdOptionalUsize,
}

pub const AD_WAIT_PREDICATE_SIZE: usize = 40;

const _: () = assert!(std::mem::size_of::<AdWaitPredicate>() == AD_WAIT_PREDICATE_SIZE);
