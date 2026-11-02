use std::os::raw::c_char;

#[repr(C)]
pub struct AdRefIdentity {
    pub role: *const c_char,
    pub name: *const c_char,
    pub value: *const c_char,
    pub description: *const c_char,
    pub native_id: *const c_char,
}

pub const AD_REF_IDENTITY_SIZE: usize = 40;

const _: () = assert!(std::mem::size_of::<AdRefIdentity>() == AD_REF_IDENTITY_SIZE);
