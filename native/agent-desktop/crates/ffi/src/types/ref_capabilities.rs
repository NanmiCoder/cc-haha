use crate::types::AdStringSlice;

#[repr(C)]
pub struct AdRefCapabilities {
    pub states: AdStringSlice,
    pub available_actions: AdStringSlice,
}

pub const AD_REF_CAPABILITIES_SIZE: usize = 32;

const _: () = assert!(std::mem::size_of::<AdRefCapabilities>() == AD_REF_CAPABILITIES_SIZE);
