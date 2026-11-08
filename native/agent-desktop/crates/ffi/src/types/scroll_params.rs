/// Scroll parameters embedded in `AdAction` when `kind == SCROLL`.
///
/// `direction` is stored as `int32_t` for the same boundary-safety
/// reason `AdAction.kind` is. Valid values are the discriminants of
/// `AdDirection`.
#[repr(C)]
pub struct AdScrollParams {
    pub direction: i32,
    pub amount: u32,
}
