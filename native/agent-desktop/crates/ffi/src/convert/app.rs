use crate::convert::string::{free_c_string, opt_string_to_c, string_to_c_lossy};
use crate::types::AdAppInfo;
use agent_desktop_core::AppInfo;
use std::os::raw::c_char;
use std::ptr;

pub(crate) fn app_info_to_c(a: &AppInfo) -> AdAppInfo {
    AdAppInfo {
        name: string_to_c_lossy(&a.name),
        pid: a.pid.get(),
        bundle_id: opt_string_to_c(a.bundle_id.as_deref()),
    }
}

pub(crate) unsafe fn free_app_info_fields(a: &mut AdAppInfo) {
    unsafe {
        free_c_string(a.name as *mut c_char);
        free_c_string(a.bundle_id as *mut c_char);
        a.name = ptr::null();
        a.bundle_id = ptr::null();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::string::c_to_string;

    #[test]
    fn test_app_info_roundtrip() {
        let a = AppInfo {
            name: "Finder".into(),
            pid: agent_desktop_core::ProcessId::new(42),
            bundle_id: Some("com.apple.finder".into()),
            process_instance: Some("42:100".into()),
            presentation: None,
        };
        let c = app_info_to_c(&a);
        assert_eq!(unsafe { c_to_string(c.name) }.as_deref(), Some("Finder"));
        assert_eq!(
            unsafe { c_to_string(c.bundle_id) }.as_deref(),
            Some("com.apple.finder")
        );
        let mut c = c;
        unsafe { free_app_info_fields(&mut c) };
    }
}
