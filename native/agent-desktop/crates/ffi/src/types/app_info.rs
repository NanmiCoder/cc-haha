use std::os::raw::c_char;

#[repr(C)]
pub struct AdAppInfo {
    pub name: *const c_char,
    pub pid: u32,
    pub bundle_id: *const c_char,
}
