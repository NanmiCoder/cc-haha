use crate::types::AdRect;
use std::os::raw::c_char;

#[repr(C)]
pub struct AdNodePresentation {
    pub states: *mut *mut c_char,
    pub bounds: AdRect,
    pub state_count: u32,
    pub has_bounds: bool,
}

pub const AD_NODE_PRESENTATION_SIZE: usize = 48;

const _: () = assert!(std::mem::size_of::<AdNodePresentation>() == AD_NODE_PRESENTATION_SIZE);
