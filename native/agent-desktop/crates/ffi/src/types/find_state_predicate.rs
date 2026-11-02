use std::os::raw::c_char;

#[repr(C)]
pub struct AdFindStatePredicate {
    pub token: *const c_char,
    pub expected: i32,
}

pub const AD_FIND_STATE_PREDICATE_SIZE: usize = 16;

const _: () = assert!(std::mem::size_of::<AdFindStatePredicate>() == AD_FIND_STATE_PREDICATE_SIZE);
