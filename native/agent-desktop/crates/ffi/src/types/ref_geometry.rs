use crate::types::AdRect;

#[repr(C)]
pub struct AdRefGeometry {
    pub bounds: AdRect,
    pub bounds_hash: u64,
    pub has_bounds: bool,
    pub has_bounds_hash: bool,
    /// Coordinate frame of `bounds`; use an `AD_BOUNDS_SPACE_*` constant.
    /// macOS and Windows geometry must be screen-relative. Linux geometry
    /// must be window-relative.
    pub bounds_space: i32,
}

pub const AD_BOUNDS_SPACE_UNKNOWN: i32 = 0;
pub const AD_BOUNDS_SPACE_SCREEN: i32 = 1;
pub const AD_BOUNDS_SPACE_WINDOW: i32 = 2;

pub const AD_REF_GEOMETRY_SIZE: usize = 48;

const _: () = assert!(std::mem::size_of::<AdRefGeometry>() == AD_REF_GEOMETRY_SIZE);
