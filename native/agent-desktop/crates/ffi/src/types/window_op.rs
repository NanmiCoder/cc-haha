/// Window-manager operation dispatched by `ad_window_op_exact`.
///
/// `kind` is stored as `int32_t` to keep the enum-discriminant check at
/// the boundary — out-of-range values return
/// `AD_RESULT_ERR_INVALID_ARGS`. Valid values are the discriminants of
/// `AdWindowOpKind`. `width`/`height`/`x`/`y` are only consulted for
/// the variants that use them.
#[repr(C)]
pub struct AdWindowOp {
    pub kind: i32,
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
}
