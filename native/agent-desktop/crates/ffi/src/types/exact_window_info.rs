use std::os::raw::c_char;

use crate::types::AdWindowInfo;

pub const AD_EXACT_WINDOW_INFO_VERSION: u32 = 2;
pub const AD_EXACT_WINDOW_INFO_SIZE: usize = 96;

/// Additive generation-pinned window identity for operations that target a
/// previously observed live window.
#[repr(C)]
pub struct AdExactWindowInfo {
    pub version: u32,
    pub size: u32,
    pub window: AdWindowInfo,
    pub process_instance: *const c_char,
    /// False only when observation confirmed no matching accessibility element.
    pub accessible: bool,
}

const _: () = assert!(std::mem::size_of::<AdExactWindowInfo>() == AD_EXACT_WINDOW_INFO_SIZE);

#[unsafe(no_mangle)]
pub extern "C" fn ad_exact_window_info_size() -> usize {
    std::mem::size_of::<AdExactWindowInfo>()
}
