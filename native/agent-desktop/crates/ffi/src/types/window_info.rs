use crate::types::rect::AdRect;
use std::os::raw::c_char;

/// Window fields embedded in `AdExactWindowInfo`, which adds the process
/// generation token every targeting API requires.
#[repr(C)]
pub struct AdWindowInfo {
    pub id: *const c_char,
    pub title: *const c_char,
    pub app_name: *const c_char,
    pub pid: u32,
    pub bounds: AdRect,
    pub has_bounds: bool,
    pub is_focused: bool,
}
