use crate::convert::string::{free_c_string, opt_string_to_c, string_to_c_lossy};
use crate::types::AdNotificationInfo;
use agent_desktop_core::NotificationInfo;
use std::os::raw::c_char;
use std::ptr;

pub(crate) fn notification_info_to_c(info: &NotificationInfo) -> AdNotificationInfo {
    let (actions_ptr, action_count) = strings_to_c_array(&info.actions);
    AdNotificationInfo {
        index: info.index as u32,
        app_name: string_to_c_lossy(&info.app_name),
        title: string_to_c_lossy(&info.title),
        body: opt_string_to_c(info.body.as_deref()),
        actions: actions_ptr,
        action_count,
    }
}

pub(crate) unsafe fn free_notification_info_fields(info: &mut AdNotificationInfo) {
    unsafe {
        free_c_string(info.app_name as *mut c_char);
        free_c_string(info.title as *mut c_char);
        free_c_string(info.body as *mut c_char);
        free_c_string_array(info.actions);
        info.app_name = ptr::null();
        info.title = ptr::null();
        info.body = ptr::null();
        info.actions = ptr::null_mut();
        info.action_count = 0;
    }
}

fn strings_to_c_array(strings: &[String]) -> (*mut *mut c_char, u32) {
    if strings.is_empty() {
        return (ptr::null_mut(), 0);
    }
    let ptrs: Vec<*mut c_char> = strings.iter().map(|s| string_to_c_lossy(s)).collect();
    let count = ptrs.len() as u32;
    let mut boxed = ptrs.into_boxed_slice();
    let ptr = boxed.as_mut_ptr();
    std::mem::forget(boxed);
    crate::resource::register_allocation(
        crate::resource::AllocationKind::NotificationActions,
        ptr,
        count as usize,
    );
    (ptr, count)
}

unsafe fn free_c_string_array(arr: *mut *mut c_char) {
    unsafe {
        let Some(count) = crate::resource::take_allocation(
            crate::resource::AllocationKind::NotificationActions,
            arr,
        ) else {
            return;
        };
        let slice = std::slice::from_raw_parts_mut(arr, count);
        for p in slice.iter_mut() {
            free_c_string(*p);
        }
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            arr, count,
        )));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::string::c_to_string;
    use agent_desktop_core::NotificationInfo;
    use std::os::raw::c_char;

    fn make_info(body: Option<&str>, actions: &[&str]) -> NotificationInfo {
        NotificationInfo {
            index: 3,
            app_name: "Messages".into(),
            title: "Hello".into(),
            body: body.map(str::to_owned),
            actions: actions.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn full_notification_maps_all_fields_to_c() {
        let info = make_info(Some("world"), &["Reply", "Mark as Read"]);
        let mut c = notification_info_to_c(&info);
        assert_eq!(c.index, 3);
        assert_eq!(
            unsafe { c_to_string(c.app_name) }.as_deref(),
            Some("Messages")
        );
        assert_eq!(unsafe { c_to_string(c.title) }.as_deref(), Some("Hello"));
        assert_eq!(unsafe { c_to_string(c.body) }.as_deref(), Some("world"));
        assert_eq!(c.action_count, 2);
        assert!(!c.actions.is_null());
        let actions = unsafe { std::slice::from_raw_parts(c.actions, c.action_count as usize) };
        assert_eq!(
            unsafe { c_to_string(actions[0] as *const c_char) }.as_deref(),
            Some("Reply")
        );
        assert_eq!(
            unsafe { c_to_string(actions[1] as *const c_char) }.as_deref(),
            Some("Mark as Read")
        );
        unsafe { free_notification_info_fields(&mut c) };
    }

    #[test]
    fn body_none_maps_to_null_body_pointer() {
        let info = make_info(None, &[]);
        let mut c = notification_info_to_c(&info);
        assert!(c.body.is_null(), "None body must yield null body pointer");
        unsafe { free_notification_info_fields(&mut c) };
    }

    #[test]
    fn empty_actions_maps_to_null_pointer_and_zero_count() {
        let info = make_info(None, &[]);
        let mut c = notification_info_to_c(&info);
        assert!(
            c.actions.is_null(),
            "empty actions slice must yield null actions pointer"
        );
        assert_eq!(c.action_count, 0);
        unsafe { free_notification_info_fields(&mut c) };
    }

    #[test]
    fn free_notification_info_fields_nulls_all_pointer_fields() {
        let info = make_info(Some("body text"), &["Open"]);
        let mut c = notification_info_to_c(&info);
        unsafe { free_notification_info_fields(&mut c) };
        assert!(c.app_name.is_null());
        assert!(c.title.is_null());
        assert!(c.body.is_null());
        assert!(c.actions.is_null());
        assert_eq!(c.action_count, 0);
    }
}
