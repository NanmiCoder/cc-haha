use std::os::raw::c_char;

#[repr(C)]
pub struct AdNotificationInfo {
    pub index: u32,
    pub app_name: *const c_char,
    pub title: *const c_char,
    pub body: *const c_char,
    pub actions: *mut *mut c_char,
    pub action_count: u32,
}
