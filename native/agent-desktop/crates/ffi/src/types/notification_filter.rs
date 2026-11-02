use std::os::raw::c_char;

#[repr(C)]
pub struct AdNotificationFilter {
    pub app: *const c_char,
    pub text: *const c_char,
    pub limit: u32,
    pub has_limit: bool,
}
