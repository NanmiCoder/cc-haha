use std::os::raw::c_char;

#[repr(C)]
pub struct AdRefSource {
    pub app: *const c_char,
    pub window_id: *const c_char,
    pub window_title: *const c_char,
    pub window_bounds_hash: u64,
    pub surface: i32,
    pub has_window_bounds_hash: bool,
}

pub const AD_REF_SOURCE_SIZE: usize = 40;

const _: () = assert!(std::mem::size_of::<AdRefSource>() == AD_REF_SOURCE_SIZE);
