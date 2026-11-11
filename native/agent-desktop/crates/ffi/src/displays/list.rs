use crate::AdAdapter;
use crate::convert::display::{display_info_to_c, free_display_info_fields, validate_display_info};
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::{trap_panic, trap_panic_void};
use crate::types::{AdDisplayInfo, AdDisplayList};
use std::ptr;

/// Lists displays in screenshot screen-index order.
///
/// # Safety
/// `adapter` must be valid and `out` must be writable. Success produces an
/// opaque list freed with `ad_display_list_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_list_displays(
    adapter: *const AdAdapter,
    out: *mut *mut AdDisplayList,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        *out = ptr::null_mut();
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let deadline = crate::operation::operation_deadline!();
        match adapter.inner.list_displays(deadline) {
            Ok(displays) => {
                if let Err(error) =
                    crate::resource::validate_list_len(displays.len(), "Display list")
                        .and_then(|_| displays.iter().try_for_each(validate_display_info))
                {
                    set_last_error(&error);
                    return crate::error::last_error_code();
                }
                let items = displays
                    .iter()
                    .map(display_info_to_c)
                    .collect::<Vec<_>>()
                    .into_boxed_slice();
                *out = Box::into_raw(Box::new(AdDisplayList { items }));
                AdResult::Ok
            }
            Err(error) => {
                set_last_error(&error);
                crate::error::last_error_code()
            }
        }
    })
}

/// # Safety
/// `list` must be null or returned by `ad_list_displays`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_display_list_count(list: *const AdDisplayList) -> u32 {
    if list.is_null() {
        return 0;
    }
    unsafe { &*list }.items.len() as u32
}

/// Returns a borrowed display entry, or null when `index` is out of range.
///
/// # Safety
/// `list` must be null or returned by `ad_list_displays`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_display_list_get(
    list: *const AdDisplayList,
    index: u32,
) -> *const AdDisplayInfo {
    if list.is_null() {
        return ptr::null();
    }
    unsafe { &*list }
        .items
        .get(index as usize)
        .map_or(ptr::null(), std::ptr::from_ref)
}

/// # Safety
/// `list` must be null or returned by `ad_list_displays`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_display_list_free(list: *mut AdDisplayList) {
    trap_panic_void(|| unsafe {
        if list.is_null() {
            return;
        }
        let mut list = Box::from_raw(list);
        for item in &mut list.items {
            free_display_info_fields(item);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_accessors_bound_borrowed_entries() {
        let list = Box::into_raw(Box::new(AdDisplayList {
            items: Vec::new().into_boxed_slice(),
        }));

        assert_eq!(unsafe { ad_display_list_count(list) }, 0);
        assert!(unsafe { ad_display_list_get(list, 0) }.is_null());
        unsafe { ad_display_list_free(list) };
    }
}
