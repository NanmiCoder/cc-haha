use crate::types::drag_params::AdDragParams;
use crate::types::key_combo::AdKeyCombo;
use crate::types::scroll_params::AdScrollParams;
use std::os::raw::c_char;

/// Action dispatched by `ad_execute_action`.
///
/// `kind` is stored as `int32_t` so a buggy or malicious C caller
/// cannot write an out-of-range discriminant into a Rust enum slot —
/// an out-of-range value is rejected with
/// `AD_RESULT_ERR_INVALID_ARGS` at the boundary. Valid values are the
/// discriminants of `AdActionKind`.
///
/// `AdDragParams` is embedded by value, so any growth there grows this
/// struct too. Callers must zero-initialize the whole struct and verify
/// layout against `AD_ACTION_SIZE` / `ad_action_size()` when binding from
/// a language whose struct layout may diverge — an under-allocated action
/// makes the library read past the caller's buffer.
#[repr(C)]
pub struct AdAction {
    pub kind: i32,
    pub text: *const c_char,
    pub scroll: AdScrollParams,
    pub key: AdKeyCombo,
    pub drag: AdDragParams,
}

pub const AD_ACTION_SIZE: usize = 96;

const _: () = assert!(std::mem::size_of::<AdAction>() == AD_ACTION_SIZE);

#[unsafe(no_mangle)]
pub extern "C" fn ad_action_size() -> usize {
    std::mem::size_of::<AdAction>()
}
