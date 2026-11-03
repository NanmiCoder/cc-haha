use std::os::raw::c_char;

use crate::types::AdSurfaceInfo;

pub const AD_EXACT_SURFACE_INFO_VERSION: u32 = 2;
pub const AD_EXACT_SURFACE_INFO_SIZE: usize = 48;

/// Additive surface observation that preserves the core surface ID.
#[repr(C)]
pub struct AdExactSurfaceInfo {
    pub version: u32,
    pub size: u32,
    pub id: *const c_char,
    pub surface: AdSurfaceInfo,
    /// Comma-separated surface kinds that could not be read for this window
    /// (for example `sheet,menu`), or null when every kind was read. A
    /// missing `sheet` or `menu` entry next to a listed kind is unknown, not
    /// absent. Present from version 2.
    pub unclassified: *const c_char,
}

const _: () = assert!(std::mem::size_of::<AdExactSurfaceInfo>() == AD_EXACT_SURFACE_INFO_SIZE);

#[unsafe(no_mangle)]
pub extern "C" fn ad_exact_surface_info_size() -> usize {
    std::mem::size_of::<AdExactSurfaceInfo>()
}
