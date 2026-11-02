use std::os::raw::c_char;

#[repr(C)]
pub struct AdNodeContent {
    pub ref_id: *const c_char,
    pub role: *const c_char,
    pub name: *const c_char,
    pub value: *const c_char,
    pub description: *const c_char,
    pub hint: *const c_char,
}

pub const AD_NODE_CONTENT_SIZE: usize = 48;

const _: () = assert!(std::mem::size_of::<AdNodeContent>() == AD_NODE_CONTENT_SIZE);
