/// Options for `ad_get_tree_exact`.
///
/// `surface` is stored as `int32_t` so foreign callers cannot write
/// an invalid discriminant into a Rust enum slot. Valid values are the
/// discriminants of `AdSnapshotSurface`; out-of-range values return
/// `AD_RESULT_ERR_INVALID_ARGS`.
#[repr(C)]
pub struct AdTreeOptions {
    pub max_depth: u8,
    pub include_bounds: bool,
    pub interactive_only: bool,
    pub compact: bool,
    pub surface: i32,
}
