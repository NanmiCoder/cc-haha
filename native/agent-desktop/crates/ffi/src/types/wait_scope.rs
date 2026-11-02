use std::os::raw::c_char;

#[repr(C)]
pub struct AdWaitScope {
    pub timeout_ms: u64,
    pub app: *const c_char,
}

pub const AD_WAIT_SCOPE_SIZE: usize = 16;

const _: () = assert!(std::mem::size_of::<AdWaitScope>() == AD_WAIT_SCOPE_SIZE);
