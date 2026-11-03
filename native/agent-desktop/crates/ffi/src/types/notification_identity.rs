use std::os::raw::c_char;

#[repr(C)]
pub struct AdNotificationIdentity {
    pub app: *const c_char,
    pub title: *const c_char,
}

pub const AD_NOTIFICATION_IDENTITY_SIZE: usize = 16;

const _: () =
    assert!(std::mem::size_of::<AdNotificationIdentity>() == AD_NOTIFICATION_IDENTITY_SIZE);
