use std::os::raw::c_char;

#[repr(C)]
pub struct AdStringSlice {
    pub items: *const *const c_char,
    pub count: usize,
}

pub const AD_STRING_SLICE_SIZE: usize = 16;

const _: () = assert!(std::mem::size_of::<AdStringSlice>() == AD_STRING_SLICE_SIZE);
