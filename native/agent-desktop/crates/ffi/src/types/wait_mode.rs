use crate::types::{AdOptionalU64, AdWaitSurfaceModes};
use std::os::raw::c_char;

#[repr(C)]
pub struct AdWaitMode {
    pub pause: AdOptionalU64,
    pub element: *const c_char,
    pub window: *const c_char,
    pub text: *const c_char,
    pub surfaces: AdWaitSurfaceModes,
}

pub const AD_WAIT_MODE_SIZE: usize = 48;

const _: () = assert!(std::mem::size_of::<AdWaitMode>() == AD_WAIT_MODE_SIZE);
