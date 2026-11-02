use crate::types::{
    AdRefCapabilities, AdRefGeometry, AdRefIdentity, AdRefProcess, AdRefScope, AdRefSource,
};

#[repr(C)]
pub struct AdRefEntry {
    pub process: AdRefProcess,
    pub identity: AdRefIdentity,
    pub geometry: AdRefGeometry,
    pub capabilities: AdRefCapabilities,
    pub source: AdRefSource,
    pub scope: AdRefScope,
}

pub const AD_REF_ENTRY_SIZE: usize = 200;

/// Per-field input caps enforced when converting an `AdRefEntry` at the C
/// boundary, sized from what real accessibility trees produce (a handful of
/// states/actions, double-digit path depth) with generous headroom. Mirrored
/// in the header so callers can validate before calling.
pub const AD_MAX_REF_STATES: usize = 64;
pub const AD_MAX_REF_ACTIONS: usize = 32;
pub const AD_MAX_REF_PATH_DEPTH: usize = 128;

const _: () = assert!(std::mem::size_of::<AdRefEntry>() == AD_REF_ENTRY_SIZE);

#[unsafe(no_mangle)]
pub extern "C" fn ad_ref_entry_size() -> usize {
    std::mem::size_of::<AdRefEntry>()
}
