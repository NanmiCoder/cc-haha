use std::os::raw::c_char;

/// Surface fields embedded in `AdExactSurfaceInfo`, which adds the surface ID.
#[repr(C)]
pub struct AdSurfaceInfo {
    pub kind: *const c_char,
    pub title: *const c_char,
    pub item_count: i64,
}
