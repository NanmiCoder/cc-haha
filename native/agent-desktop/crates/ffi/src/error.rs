use crate::types::AdDeliverySemantics;
use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use std::cell::RefCell;
use std::ffi::{CStr, CString, c_char};

/// New result codes may be appended in future releases. Always handle values
/// outside this list.
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdResult {
    Ok = 0,
    ErrPermDenied = -1,
    ErrElementNotFound = -2,
    ErrAppNotFound = -3,
    ErrActionFailed = -4,
    ErrActionNotSupported = -5,
    ErrStaleRef = -6,
    ErrWindowNotFound = -7,
    ErrPlatformNotSupported = -8,
    ErrTimeout = -9,
    ErrInvalidArgs = -10,
    ErrNotificationNotFound = -11,
    ErrInternal = -12,
    ErrSnapshotNotFound = -13,
    ErrPolicyDenied = -14,
    ErrAmbiguousTarget = -15,
    ErrAppUnresponsive = -16,
}

const _: () = assert!(AdResult::ErrPermDenied as i32 == -1);
const _: () = assert!(AdResult::ErrElementNotFound as i32 == -2);
const _: () = assert!(AdResult::ErrAppNotFound as i32 == -3);
const _: () = assert!(AdResult::ErrActionFailed as i32 == -4);
const _: () = assert!(AdResult::ErrActionNotSupported as i32 == -5);
const _: () = assert!(AdResult::ErrStaleRef as i32 == -6);
const _: () = assert!(AdResult::ErrWindowNotFound as i32 == -7);
const _: () = assert!(AdResult::ErrPlatformNotSupported as i32 == -8);
const _: () = assert!(AdResult::ErrTimeout as i32 == -9);
const _: () = assert!(AdResult::ErrInvalidArgs as i32 == -10);
const _: () = assert!(AdResult::ErrNotificationNotFound as i32 == -11);
const _: () = assert!(AdResult::ErrInternal as i32 == -12);
const _: () = assert!(AdResult::ErrSnapshotNotFound as i32 == -13);
const _: () = assert!(AdResult::ErrPolicyDenied as i32 == -14);
const _: () = assert!(AdResult::ErrAmbiguousTarget as i32 == -15);
const _: () = assert!(AdResult::ErrAppUnresponsive as i32 == -16);

enum MessageSource {
    Owned(CString),
    Static(&'static CStr),
}

impl MessageSource {
    fn as_ptr(&self) -> *const c_char {
        match self {
            MessageSource::Owned(cs) => cs.as_ptr(),
            MessageSource::Static(cs) => cs.as_ptr(),
        }
    }

    #[cfg(test)]
    fn to_owned_string(&self) -> String {
        match self {
            MessageSource::Owned(cs) => cs.to_string_lossy().into_owned(),
            MessageSource::Static(cs) => cs.to_string_lossy().into_owned(),
        }
    }
}

struct StoredError {
    code: AdResult,
    message: MessageSource,
    suggestion: Option<CString>,
    platform_detail: Option<CString>,
    details: Option<CString>,
    disposition: DeliverySemantics,
}

static NUL_BYTE_FALLBACK: &CStr = c"(message contained null byte)";

thread_local! {
    static LAST_ERROR: RefCell<Option<StoredError>> = const { RefCell::new(None) };
}

fn replace_last_error(error: StoredError) {
    let mut error = Some(error);
    let _ = LAST_ERROR.try_with(|cell| {
        if let Ok(mut slot) = cell.try_borrow_mut() {
            *slot = error.take();
        }
    });
}

/// Maps a core `ErrorCode` to its stable C-ABI `AdResult`. `ErrorCode` and the
/// error variants of `AdResult` are a bijection: each maps to exactly one of the
/// other. This match is exhaustive over `ErrorCode`, so a new `ErrorCode` cannot
/// be added without a result here (forward-drift guard); the reverse direction is
/// guarded by `error_code_and_ad_result_error_variants_stay_in_bijection` in the
/// tests. When adding an error, update both this match and the `AdResult` enum.
fn error_code_to_result(code: &ErrorCode) -> AdResult {
    match code {
        ErrorCode::PermDenied => AdResult::ErrPermDenied,
        ErrorCode::ElementNotFound => AdResult::ErrElementNotFound,
        ErrorCode::AppNotFound => AdResult::ErrAppNotFound,
        ErrorCode::ActionFailed => AdResult::ErrActionFailed,
        ErrorCode::ActionNotSupported => AdResult::ErrActionNotSupported,
        ErrorCode::StaleRef => AdResult::ErrStaleRef,
        ErrorCode::AmbiguousTarget => AdResult::ErrAmbiguousTarget,
        ErrorCode::WindowNotFound => AdResult::ErrWindowNotFound,
        ErrorCode::PlatformNotSupported => AdResult::ErrPlatformNotSupported,
        ErrorCode::Timeout => AdResult::ErrTimeout,
        ErrorCode::InvalidArgs => AdResult::ErrInvalidArgs,
        ErrorCode::NotificationNotFound => AdResult::ErrNotificationNotFound,
        ErrorCode::Internal => AdResult::ErrInternal,
        ErrorCode::SnapshotNotFound => AdResult::ErrSnapshotNotFound,
        ErrorCode::PolicyDenied => AdResult::ErrPolicyDenied,
        ErrorCode::AppUnresponsive => AdResult::ErrAppUnresponsive,
    }
}

pub(crate) fn set_last_error(err: &AdapterError) {
    let code = error_code_to_result(&err.code);
    let message = match CString::new(err.message.as_str()) {
        Ok(cs) => MessageSource::Owned(cs),
        Err(_) => MessageSource::Static(NUL_BYTE_FALLBACK),
    };
    let suggestion = err.suggestion.as_deref().and_then(|s| CString::new(s).ok());
    let platform_detail = err
        .platform_detail
        .as_deref()
        .and_then(|s| CString::new(s).ok());
    let details = err
        .details
        .as_ref()
        .and_then(|details| serde_json::to_string(details).ok())
        .and_then(|details| CString::new(details).ok());
    replace_last_error(StoredError {
        code,
        message,
        suggestion,
        platform_detail,
        details,
        disposition: err.disposition,
    });
}

#[cfg(test)]
pub(crate) fn clear_last_error() {
    let _ = LAST_ERROR.try_with(|cell| {
        if let Ok(mut slot) = cell.try_borrow_mut() {
            *slot = None;
        }
    });
}

#[cfg(test)]
pub(crate) fn with_last_error_mutably_borrowed<R>(body: impl FnOnce() -> R) -> R {
    LAST_ERROR.with(|cell| {
        let _borrow = cell.borrow_mut();
        body()
    })
}

/// Sets the last-error using a `'static CStr` message. Never allocates,
/// never panics — safe to call from a panic handler.
pub(crate) fn set_last_error_static(code: AdResult, message: &'static CStr) {
    replace_last_error(StoredError {
        code,
        message: MessageSource::Static(message),
        suggestion: None,
        platform_detail: None,
        details: None,
        disposition: DeliverySemantics::unknown(),
    });
}

pub(crate) fn last_error_code() -> AdResult {
    LAST_ERROR
        .try_with(|cell| {
            cell.try_borrow()
                .ok()
                .and_then(|error| error.as_ref().map(|error| error.code))
                .unwrap_or(AdResult::Ok)
        })
        .unwrap_or(AdResult::Ok)
}

fn last_error_disposition() -> DeliverySemantics {
    LAST_ERROR
        .try_with(|cell| {
            cell.try_borrow()
                .ok()
                .and_then(|error| error.as_ref().map(|error| error.disposition))
                .unwrap_or_else(DeliverySemantics::unknown)
        })
        .unwrap_or_else(|_| DeliverySemantics::unknown())
}

/// Last-error lifetime — errno-style.
///
/// The pointer returned by `ad_last_error_message`,
/// `ad_last_error_suggestion`, and `ad_last_error_platform_detail`
/// remains valid across any number of subsequent **successful** FFI
/// calls on the same thread. Only the next FFI call that itself **fails**
/// (returns a non-`AD_RESULT_OK` code) invalidates the previous pointers.
///
/// Consumers can therefore read an error once, cache the pointer, and
/// keep reading it back across follow-up work that clears or re-fetches
/// state before handing control to the user.
///
/// This matches the POSIX `errno` / `strerror` contract and is scoped
/// per-thread via thread-local storage — Thread A's last-error never
/// leaks to Thread B.
/// Returns the `AdResult` code of the last error on the calling thread,
/// or `AD_RESULT_OK` if no error has been recorded.
#[unsafe(no_mangle)]
pub extern "C" fn ad_last_error_code() -> AdResult {
    crate::ffi_try::trap_panic(last_error_code)
}

/// Returns a borrowed C string describing the last error, or null if no
/// error has been recorded on the calling thread. The pointer remains
/// valid across any number of subsequent *successful* FFI calls; only
/// the next failing call overwrites it.
#[unsafe(no_mangle)]
pub extern "C" fn ad_last_error_message() -> *const c_char {
    crate::ffi_try::trap_panic_const_ptr(|| {
        LAST_ERROR
            .try_with(|cell| {
                cell.try_borrow()
                    .ok()
                    .and_then(|error| error.as_ref().map(|error| error.message.as_ptr()))
                    .unwrap_or(std::ptr::null())
            })
            .unwrap_or(std::ptr::null())
    })
}

/// Returns a borrowed C string with a human-readable suggestion for how
/// to recover from the last error, or null if the adapter didn't emit
/// one. Same lifetime rules as `ad_last_error_message`.
#[unsafe(no_mangle)]
pub extern "C" fn ad_last_error_suggestion() -> *const c_char {
    crate::ffi_try::trap_panic_const_ptr(|| {
        LAST_ERROR
            .try_with(|cell| {
                cell.try_borrow()
                    .ok()
                    .and_then(|error| {
                        error
                            .as_ref()
                            .and_then(|error| error.suggestion.as_ref().map(|value| value.as_ptr()))
                    })
                    .unwrap_or(std::ptr::null())
            })
            .unwrap_or(std::ptr::null())
    })
}

/// Returns a borrowed C string carrying a platform-specific diagnostic
/// for the last error (AX error codes, COM HRESULTs, AT-SPI messages,
/// etc.), or null if the adapter didn't supply one. Same lifetime rules
/// as `ad_last_error_message`.
#[unsafe(no_mangle)]
pub extern "C" fn ad_last_error_platform_detail() -> *const c_char {
    crate::ffi_try::trap_panic_const_ptr(|| {
        LAST_ERROR
            .try_with(|cell| {
                cell.try_borrow()
                    .ok()
                    .and_then(|error| {
                        error.as_ref().and_then(|error| {
                            error.platform_detail.as_ref().map(|value| value.as_ptr())
                        })
                    })
                    .unwrap_or(std::ptr::null())
            })
            .unwrap_or(std::ptr::null())
    })
}

/// Returns a borrowed JSON string carrying structured details for the last
/// error, or null if the adapter didn't supply any. Same lifetime rules as
/// `ad_last_error_message`. Details may contain element names, values, and
/// window titles from the user's screen; treat as sensitive diagnostics and
/// avoid routing to shared log surfaces.
#[unsafe(no_mangle)]
pub extern "C" fn ad_last_error_details() -> *const c_char {
    crate::ffi_try::trap_panic_const_ptr(|| {
        LAST_ERROR
            .try_with(|cell| {
                cell.try_borrow()
                    .ok()
                    .and_then(|error| {
                        error
                            .as_ref()
                            .and_then(|error| error.details.as_ref().map(|value| value.as_ptr()))
                    })
                    .unwrap_or(std::ptr::null())
            })
            .unwrap_or(std::ptr::null())
    })
}

/// Writes the delivery and retry semantics associated with the calling
/// thread's last error. If no error has been recorded, both values are
/// `UNKNOWN`. This successful read does not clear or replace last-error state.
///
/// # Safety
///
/// `out` must point to writable `AdDeliverySemantics` storage.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_last_error_delivery_semantics(
    out: *mut AdDeliverySemantics,
) -> AdResult {
    crate::ffi_try::trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        *out = AdDeliverySemantics::from_core(last_error_disposition());
        AdResult::Ok
    })
}

#[cfg(test)]
#[path = "error_tests.rs"]
mod tests;
