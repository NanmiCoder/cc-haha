#![allow(improper_ctypes)]

use agent_desktop_ffi::{
    AD_DISPLAY_INFO_SIZE, AD_DISPLAY_INFO_VERSION, AdAdapter, AdDisplayInfo, AdDisplayList,
    AdResult,
};
use std::mem::{offset_of, size_of};

unsafe extern "C" {
    fn ad_list_displays(adapter: *const AdAdapter, out: *mut *mut AdDisplayList) -> AdResult;
    fn ad_display_list_count(list: *const AdDisplayList) -> u32;
    fn ad_display_list_get(list: *const AdDisplayList, index: u32) -> *const AdDisplayInfo;
    fn ad_display_list_free(list: *mut AdDisplayList);
}

#[test]
fn list_displays_rejects_null_adapter_and_clears_out() {
    unsafe {
        let mut list = std::ptr::dangling_mut::<AdDisplayList>();
        let result = ad_list_displays(std::ptr::null(), &mut list);

        assert_eq!(result, AdResult::ErrInvalidArgs);
        assert!(list.is_null());
    }
}

#[test]
fn display_info_layout_is_pinned() {
    assert_eq!(AD_DISPLAY_INFO_VERSION, 1);
    assert_eq!(AD_DISPLAY_INFO_SIZE, 64);
    assert_eq!(size_of::<AdDisplayInfo>(), AD_DISPLAY_INFO_SIZE);
    assert_eq!(offset_of!(AdDisplayInfo, version), 0);
    assert_eq!(offset_of!(AdDisplayInfo, size), 4);
    assert_eq!(offset_of!(AdDisplayInfo, id), 8);
    assert_eq!(offset_of!(AdDisplayInfo, bounds), 16);
    assert_eq!(offset_of!(AdDisplayInfo, is_primary), 48);
    assert_eq!(offset_of!(AdDisplayInfo, scale), 56);
}

#[test]
fn display_list_accessors_are_null_tolerant() {
    unsafe {
        assert_eq!(ad_display_list_count(std::ptr::null()), 0);
        assert!(ad_display_list_get(std::ptr::null(), 0).is_null());
        ad_display_list_free(std::ptr::null_mut());
    }
}
