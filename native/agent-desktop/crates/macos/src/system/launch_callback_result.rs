use std::ffi::{c_char, c_void};

#[repr(C)]
pub(crate) struct LaunchCallbackResult {
    pub(crate) application: *mut c_void,
    pub(crate) pid: i32,
    pub(crate) launch_time: f64,
    pub(crate) terminated: u8,
    pub(crate) delivery_started: u8,
    pub(crate) error_kind: u8,
    pub(crate) error: *const c_char,
    pub(crate) error_len: usize,
}
