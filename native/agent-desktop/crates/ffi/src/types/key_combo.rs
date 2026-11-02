use std::os::raw::c_char;

/// Key combination: a named key plus optional modifier list.
///
/// `modifiers` points to an array of `int32_t` values (not a typed Rust
/// enum array) so the C boundary cannot be tricked into writing an
/// out-of-range discriminant into a Rust enum slot. Each entry is
/// validated against `AdModifier` before use; an invalid discriminant
/// returns `AD_RESULT_ERR_INVALID_ARGS`.
#[repr(C)]
pub struct AdKeyCombo {
    pub key: *const c_char,
    pub modifiers: *const i32,
    pub modifier_count: u32,
}
