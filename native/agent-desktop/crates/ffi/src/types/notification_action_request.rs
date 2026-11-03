use crate::types::AdNotificationIdentity;
use std::os::raw::c_char;

#[repr(C)]
pub struct AdNotificationActionRequest {
    pub index: u32,
    pub policy: i32,
    pub action_name: *const c_char,
    pub identity: AdNotificationIdentity,
}

pub const AD_NOTIFICATION_ACTION_REQUEST_SIZE: usize = 32;

const _: () = assert!(
    std::mem::size_of::<AdNotificationActionRequest>() == AD_NOTIFICATION_ACTION_REQUEST_SIZE
);
