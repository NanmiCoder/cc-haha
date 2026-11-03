use std::ffi::{c_char, c_int, c_void};

#[repr(C)]
struct DlInfo {
    filename: *const c_char,
    base: *mut c_void,
    symbol_name: *const c_char,
    symbol_address: *mut c_void,
}

pub(crate) fn containing_image() -> Option<std::path::PathBuf> {
    let mut info = DlInfo {
        filename: std::ptr::null(),
        base: std::ptr::null_mut(),
        symbol_name: std::ptr::null(),
        symbol_address: std::ptr::null_mut(),
    };
    let address = containing_image as *const () as *const c_void;
    if unsafe { dladdr(address, &mut info) } == 0 || info.filename.is_null() {
        return None;
    }
    let bytes = unsafe { std::ffi::CStr::from_ptr(info.filename) };
    Some(std::path::PathBuf::from(bytes.to_string_lossy().as_ref()))
}

unsafe extern "C" {
    fn dladdr(address: *const c_void, info: *mut DlInfo) -> c_int;
}
