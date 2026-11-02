use crate::AdAdapter;
use crate::convert::string::{c_to_string, string_to_c_lossy};
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::types::AdNativeHandle;
use std::os::raw::c_char;

enum Property {
    Value,
    Bounds,
}

impl Property {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "value" => Some(Self::Value),
            "bounds" => Some(Self::Bounds),
            _ => None,
        }
    }
}

/// Reads a single property off a previously-resolved element handle.
///
/// Supported properties:
/// - `"value"`  — live textual value (text fields, sliders, progress
///   indicators). Null out-string when the element has no value.
/// - `"bounds"` — JSON-encoded `{"x":..,"y":..,"width":..,"height":..}`.
///   Null out-string when bounds are unavailable.
///
/// The returned string must be freed with `ad_free_string`.
///
/// # Safety
/// `adapter` must be valid. `handle` must be a non-null `AdNativeHandle`
/// produced by the same live adapter and freed before that adapter is destroyed.
/// `property` must be a non-null UTF-8 C string. `out` must be a valid
/// writable `*mut *mut c_char`; it is null-initialized on entry.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_get(
    adapter: *const AdAdapter,
    handle: *const AdNativeHandle,
    property: *const c_char,
    out: *mut *mut c_char,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        *out = std::ptr::null_mut();
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(handle, c"handle is null");
        let prop = match c_to_string(property) {
            Some(s) => s,
            None => {
                set_last_error(&agent_desktop_core::AdapterError::new(
                    agent_desktop_core::ErrorCode::InvalidArgs,
                    "property is null or invalid UTF-8",
                ));
                return AdResult::ErrInvalidArgs;
            }
        };
        let property = match Property::parse(&prop) {
            Some(property) => property,
            None => {
                set_last_error(&agent_desktop_core::AdapterError::new(
                    agent_desktop_core::ErrorCode::InvalidArgs,
                    "unknown property — expected one of: value, bounds",
                ));
                return AdResult::ErrInvalidArgs;
            }
        };
        let adapter_id = adapter.addr();
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let (native, _) =
            match crate::actions::native_handle::acquire_ffi_handle(adapter_id, &*handle) {
                Ok(native) => native,
                Err(error) => {
                    set_last_error(&error);
                    return AdResult::ErrInvalidArgs;
                }
            };
        let deadline = crate::operation::operation_deadline!();

        match property {
            Property::Value => match adapter.inner.get_live_value(native.as_ref(), deadline) {
                Ok(Some(v)) => {
                    *out = string_to_c_lossy(&v);
                    AdResult::Ok
                }
                Ok(None) => AdResult::Ok,
                Err(e) => {
                    set_last_error(&e);
                    crate::error::last_error_code()
                }
            },
            Property::Bounds => match adapter.inner.get_element_bounds(native.as_ref(), deadline) {
                Ok(Some(r)) => {
                    let json = format!(
                        "{{\"x\":{},\"y\":{},\"width\":{},\"height\":{}}}",
                        r.x, r.y, r.width, r.height
                    );
                    *out = string_to_c_lossy(&json);
                    AdResult::Ok
                }
                Ok(None) => AdResult::Ok,
                Err(e) => {
                    set_last_error(&e);
                    crate::error::last_error_code()
                }
            },
        }
    })
}

#[cfg(test)]
#[path = "get_abi_tests.rs"]
mod tests;
