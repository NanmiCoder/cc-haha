use crate::types::AdRect;
use std::os::raw::c_char;

pub const AD_DISPLAY_INFO_VERSION: u32 = 1;
pub const AD_DISPLAY_INFO_SIZE: usize = 64;

#[repr(C)]
pub struct AdDisplayInfo {
    pub version: u32,
    pub size: u32,
    pub id: *const c_char,
    pub bounds: AdRect,
    pub is_primary: bool,
    pub scale: f64,
}

const _: () = assert!(std::mem::size_of::<AdDisplayInfo>() == AD_DISPLAY_INFO_SIZE);

#[unsafe(no_mangle)]
pub extern "C" fn ad_display_info_size() -> usize {
    std::mem::size_of::<AdDisplayInfo>()
}
