use std::os::raw::c_char;

#[repr(C)]
pub struct AdElementState {
    pub role: *const c_char,
    pub states: *mut *mut c_char,
    pub state_count: u32,
    pub value: *const c_char,
}

pub const AD_ELEMENT_STATE_SIZE: usize = 32;

const _: () = assert!(std::mem::size_of::<AdElementState>() == AD_ELEMENT_STATE_SIZE);

#[unsafe(no_mangle)]
pub extern "C" fn ad_element_state_size() -> usize {
    std::mem::size_of::<AdElementState>()
}
