use std::ffi::CString;
use std::os::raw::c_char;
use std::ptr;

use agent_desktop_core::{AdapterError, ErrorCode};

pub(crate) fn string_to_c(s: &str) -> *mut c_char {
    match CString::new(s) {
        Ok(cs) => into_registered_c_string(cs),
        Err(_) => ptr::null_mut(),
    }
}

/// Lossy variant for **mandatory** C-string fields. Replaces any interior
/// NUL byte with U+FFFD (3-byte UTF-8) before `CString::new`, so the
/// result is never null on NUL-containing input. Use for fields the
/// ABI contract forbids from being null (role, app_name, kind, ...).
/// Optional fields should keep using `opt_string_to_c`.
pub(crate) fn string_to_c_lossy(s: &str) -> *mut c_char {
    if !s.bytes().any(|b| b == 0) {
        return string_to_c(s);
    }
    let cleaned: String = s
        .chars()
        .map(|c| if c == '\0' { '\u{FFFD}' } else { c })
        .collect();
    match CString::new(cleaned) {
        Ok(cs) => into_registered_c_string(cs),
        Err(_) => ptr::null_mut(),
    }
}

pub(crate) fn opt_string_to_c(s: Option<&str>) -> *mut c_char {
    match s {
        Some(s) => string_to_c_lossy(s),
        None => ptr::null_mut(),
    }
}

pub(crate) unsafe fn free_c_string(ptr: *mut c_char) {
    unsafe {
        if crate::resource::take_allocation(crate::resource::AllocationKind::CString, ptr)
            == Some(1)
        {
            drop(CString::from_raw(ptr));
        }
    }
}

fn into_registered_c_string(value: CString) -> *mut c_char {
    let ptr = value.into_raw();
    crate::resource::register_allocation(crate::resource::AllocationKind::CString, ptr, 1);
    ptr
}

/// Maximum byte length (excluding the NUL terminator) accepted for any
/// foreign C string. Bounds both the terminator scan and the resulting
/// allocation, so a missing NUL or a hostile caller cannot walk arbitrary
/// memory into a `String`. Sized to roughly match the CLI's argv ceiling so
/// payload-bearing calls (clipboard-set, type) keep CLI parity rather than
/// being cut off at a ref-field-sized cap. Mirrored in the header as
/// `AD_MAX_STRING_BYTES`.
pub const AD_MAX_STRING_BYTES: usize = 1024 * 1024;

pub(crate) enum CStrDecodeError {
    NotUtf8,
    TooLong,
}

impl CStrDecodeError {
    pub(crate) fn describe(&self, field: &str) -> String {
        match self {
            Self::NotUtf8 => format!("{field} is not valid UTF-8"),
            Self::TooLong => {
                format!("{field} exceeds AD_MAX_STRING_BYTES ({AD_MAX_STRING_BYTES} bytes)")
            }
        }
    }
}

unsafe fn bounded_c_bytes<'a>(ptr: *const c_char) -> Result<&'a [u8], CStrDecodeError> {
    for len in 0..=AD_MAX_STRING_BYTES {
        if unsafe { *ptr.add(len) } == 0 {
            return Ok(unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), len) });
        }
    }
    Err(CStrDecodeError::TooLong)
}

pub(crate) unsafe fn c_to_string(ptr: *const c_char) -> Option<String> {
    unsafe { try_c_to_string(ptr) }.ok().flatten()
}

/// Tri-state decode of a foreign C string used for optional filter
/// fields where conflating null with invalid UTF-8 would silently widen
/// an operation (e.g. treat "bad bytes" as "no filter").
///
/// - `Ok(None)` — pointer is null. Caller should treat as "filter
///   absent".
/// - `Ok(Some(s))` — pointer is non-null, NUL-terminated within
///   `AD_MAX_STRING_BYTES`, and decodes as valid UTF-8.
/// - `Err(e)` — pointer is non-null but the bytes are not UTF-8 or no
///   terminator was found within the byte cap. Caller should surface
///   `AD_RESULT_ERR_INVALID_ARGS` (via `e.describe(field)`) instead of
///   treating this as missing.
///
/// # Safety
/// `ptr` must be null or point to readable memory that is NUL-terminated
/// within `AD_MAX_STRING_BYTES + 1` bytes.
pub(crate) unsafe fn try_c_to_string(
    ptr: *const c_char,
) -> Result<Option<String>, CStrDecodeError> {
    if ptr.is_null() {
        return Ok(None);
    }
    let bytes = unsafe { bounded_c_bytes(ptr) }?;
    std::str::from_utf8(bytes)
        .map(|s| Some(s.to_owned()))
        .map_err(|_| CStrDecodeError::NotUtf8)
}

pub(crate) fn optional_adapter_string(
    ptr: *const c_char,
    field: &str,
) -> Result<Option<String>, AdapterError> {
    unsafe { try_c_to_string(ptr) }
        .map_err(|err| AdapterError::new(ErrorCode::InvalidArgs, err.describe(field)))
}

pub(crate) fn required_adapter_string(
    ptr: *const c_char,
    field: &str,
) -> Result<String, AdapterError> {
    optional_adapter_string(ptr, field)?
        .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, format!("{field} is null")))
}

/// Decode an optional filter string, short-circuiting the enclosing
/// `AdResult`-returning fn with `AD_RESULT_ERR_INVALID_ARGS` (and a
/// tailored last-error diagnostic) when the pointer is non-null but the
/// bytes are not UTF-8 or exceed the byte cap. Null → `None` (treated as
/// "no filter").
macro_rules! decode_optional_filter {
    ($ptr:expr, $label:expr) => {{
        match $crate::convert::string::try_c_to_string($ptr) {
            Ok(value) => value,
            Err(err) => {
                $crate::error::set_last_error(&agent_desktop_core::AdapterError::new(
                    agent_desktop_core::ErrorCode::InvalidArgs,
                    err.describe($label),
                ));
                return $crate::error::AdResult::ErrInvalidArgs;
            }
        }
    }};
}

pub(crate) use decode_optional_filter;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_string_roundtrip() {
        let c = string_to_c("hello");
        assert!(!c.is_null());
        let back = unsafe { c_to_string(c) };
        assert_eq!(back.as_deref(), Some("hello"));
        unsafe { free_c_string(c) };
    }

    #[test]
    fn test_null_string() {
        let c = opt_string_to_c(None);
        assert!(c.is_null());
        let back = unsafe { c_to_string(c) };
        assert_eq!(back, None);
    }

    #[test]
    fn optional_string_with_interior_nul_stays_present() {
        let c = opt_string_to_c(Some("before\0after"));
        assert!(!c.is_null());
        assert_eq!(
            unsafe { c_to_string(c) }.as_deref(),
            Some("before\u{FFFD}after")
        );
        unsafe { free_c_string(c) };
    }

    #[test]
    fn test_free_null_is_noop() {
        unsafe { free_c_string(ptr::null_mut()) };
    }

    #[test]
    fn free_rejects_unowned_and_double_freed_pointers() {
        let foreign = CString::new("foreign").unwrap().into_raw();
        unsafe { free_c_string(foreign) };
        assert_eq!(
            unsafe { std::ffi::CStr::from_ptr(foreign) }.to_bytes(),
            b"foreign"
        );
        unsafe { drop(CString::from_raw(foreign)) };

        let owned = string_to_c("owned");
        unsafe {
            free_c_string(owned);
            free_c_string(owned);
        }
    }

    #[test]
    fn test_lossy_no_nul_same_as_string_to_c() {
        let c = string_to_c_lossy("hello");
        assert!(!c.is_null());
        let back = unsafe { c_to_string(c) };
        assert_eq!(back.as_deref(), Some("hello"));
        unsafe { free_c_string(c) };
    }

    #[test]
    fn test_lossy_replaces_interior_nul() {
        let c = string_to_c_lossy("foo\0\0bar");
        assert!(!c.is_null());
        let back = unsafe { c_to_string(c) }.unwrap();
        assert_eq!(back, "foo\u{FFFD}\u{FFFD}bar");
        unsafe { free_c_string(c) };
    }

    #[test]
    fn test_lossy_handles_all_nul_input() {
        let c = string_to_c_lossy("\0\0\0");
        assert!(!c.is_null());
        let back = unsafe { c_to_string(c) }.unwrap();
        assert_eq!(back, "\u{FFFD}\u{FFFD}\u{FFFD}");
        unsafe { free_c_string(c) };
    }

    #[test]
    fn try_c_to_string_null_is_ok_none() {
        let result = unsafe { try_c_to_string(ptr::null()) };
        assert!(matches!(result, Ok(None)));
    }

    #[test]
    fn try_c_to_string_valid_utf8_is_some() {
        let c = string_to_c("agent");
        let result = unsafe { try_c_to_string(c) };
        assert!(matches!(result, Ok(Some(ref s)) if s == "agent"));
        unsafe { free_c_string(c) };
    }

    #[test]
    fn try_c_to_string_invalid_utf8_is_err() {
        let bad: [u8; 3] = [0xC3, 0xFF, 0x00];
        let result = unsafe { try_c_to_string(bad.as_ptr() as *const c_char) };
        assert!(matches!(result, Err(CStrDecodeError::NotUtf8)));
    }

    #[test]
    fn try_c_to_string_caps_unterminated_input() {
        let unterminated = vec![b'a'; AD_MAX_STRING_BYTES + 1];
        let result = unsafe { try_c_to_string(unterminated.as_ptr() as *const c_char) };
        assert!(matches!(result, Err(CStrDecodeError::TooLong)));
    }

    #[test]
    fn try_c_to_string_accepts_exact_cap_length() {
        let mut max_len = vec![b'a'; AD_MAX_STRING_BYTES];
        max_len.push(0);
        let result = unsafe { try_c_to_string(max_len.as_ptr() as *const c_char) };
        assert_eq!(
            result.ok().flatten().map(|s| s.len()),
            Some(AD_MAX_STRING_BYTES)
        );
    }

    #[test]
    fn empty_c_string_decodes_as_some_empty_not_none() {
        let c = string_to_c("");
        assert!(!c.is_null());
        let result = unsafe { try_c_to_string(c) };
        assert!(
            matches!(result, Ok(Some(ref s)) if s.is_empty()),
            "empty C string must be Some(\"\"), not None (null) or Err"
        );
        unsafe { free_c_string(c) };
    }

    #[test]
    fn c_to_string_empty_string_is_some_empty_not_none() {
        let c = string_to_c("");
        assert_eq!(
            unsafe { c_to_string(c) }.as_deref(),
            Some(""),
            "c_to_string on \"\" must yield Some(\"\"), distinguishable from null→None"
        );
        unsafe { free_c_string(c) };
    }

    #[test]
    fn required_adapter_string_null_ptr_returns_err_naming_the_field() {
        let err = required_adapter_string(ptr::null(), "app_name").unwrap_err();
        assert_eq!(err.code, agent_desktop_core::ErrorCode::InvalidArgs);
        assert_eq!(err.message, "app_name is null");
    }

    #[test]
    fn optional_adapter_string_invalid_utf8_returns_err_naming_the_field() {
        let bad: [u8; 3] = [0xFF, 0xFE, 0x00];
        let err = optional_adapter_string(bad.as_ptr() as *const c_char, "role").unwrap_err();
        assert_eq!(err.code, agent_desktop_core::ErrorCode::InvalidArgs);
        assert_eq!(err.message, "role is not valid UTF-8");
    }
}
