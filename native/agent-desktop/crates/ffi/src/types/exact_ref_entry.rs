use std::os::raw::c_char;

use crate::types::AdRefEntry;

pub const AD_EXACT_REF_ENTRY_VERSION: u32 = 2;
pub const AD_EXACT_REF_ENTRY_SIZE: usize = 224;

/// Additive exact-identity payload for low-level struct-based ref actions.
///
/// Callers must set `version` to `AD_EXACT_REF_ENTRY_VERSION`, `size` to
/// `AD_EXACT_REF_ENTRY_SIZE`, and `process_instance` to the generation token
/// emitted by the snapshot. When `entry.identity.native_id` is non-null,
/// `identifier_kind` must name its exact platform identifier namespace.
#[repr(C)]
pub struct AdExactRefEntry {
    pub version: u32,
    pub size: u32,
    pub entry: AdRefEntry,
    pub process_instance: *const c_char,
    pub identifier_kind: i32,
}

const _: () = assert!(std::mem::size_of::<AdExactRefEntry>() == AD_EXACT_REF_ENTRY_SIZE);

#[unsafe(no_mangle)]
pub extern "C" fn ad_exact_ref_entry_size() -> usize {
    std::mem::size_of::<AdExactRefEntry>()
}
