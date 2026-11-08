//! The one place a COM status code is named.
//!
//! Both the permission probe and the UI Automation tree path classify and
//! format HRESULTs. Holding two tables meant adding a code in one and reading
//! it as unnamed in the other, so the table lives here and both import it.
//!
//! `hresult_record` carries that further: it is the single match naming every
//! HRESULT's `ReadDisposition` *and* its caller-facing `ErrorCode` together.
//! `classify_read_hresult` used to run its own separate match over the same
//! HRESULT set that `crates/windows/src/tree/automation_classify.rs`'s
//! `hresult_disposition` matched independently - the two tables agreed only
//! because both were edited by hand together, and nothing forced that. One
//! record per code makes a code's disposition and its error code the same
//! fact, written once.

#[cfg(target_os = "windows")]
use agent_desktop_core::AdapterError;
use agent_desktop_core::ErrorCode;

pub(crate) const S_OK: i32 = 0;
pub(crate) const E_NOINTERFACE: i32 = 0x8000_4002_u32 as i32;
pub(crate) const E_POINTER: i32 = 0x8000_4003_u32 as i32;
pub(crate) const E_FAIL: i32 = 0x8000_4005_u32 as i32;
pub(crate) const E_UNEXPECTED: i32 = 0x8000_FFFF_u32 as i32;
pub(crate) const E_ACCESSDENIED: i32 = 0x8007_0005_u32 as i32;
pub(crate) const E_INVALIDARG: i32 = 0x8007_0057_u32 as i32;
pub(crate) const CO_E_NOTINITIALIZED: i32 = 0x8004_01F0_u32 as i32;
pub(crate) const RPC_E_SERVERFAULT: i32 = 0x8001_0105_u32 as i32;
pub(crate) const RPC_E_DISCONNECTED: i32 = 0x8001_0108_u32 as i32;
pub(crate) const RPC_S_SERVER_UNAVAILABLE: i32 = 0x8007_06BA_u32 as i32;
pub(crate) const RPC_S_CALL_FAILED: i32 = 0x8007_06BE_u32 as i32;
pub(crate) const UIA_E_ELEMENTNOTENABLED: i32 = 0x8004_0200_u32 as i32;
pub(crate) const UIA_E_ELEMENTNOTAVAILABLE: i32 = 0x8004_0201_u32 as i32;
pub(crate) const UIA_E_NOCLICKABLEPOINT: i32 = 0x8004_0202_u32 as i32;
pub(crate) const UIA_E_PROXYASSEMBLYNOTLOADED: i32 = 0x8004_0203_u32 as i32;
pub(crate) const UIA_E_NOTSUPPORTED: i32 = 0x8004_0204_u32 as i32;
pub(crate) const UIA_E_TIMEOUT: i32 = 0x8013_1505_u32 as i32;
pub(crate) const UIA_E_INVALIDOPERATION: i32 = 0x8013_1509_u32 as i32;
pub(crate) const WINCODEC_ERR_COMPONENTNOTFOUND: i32 = 0x8898_2F50_u32 as i32;
pub(crate) const WINCODEC_ERR_BADIMAGE: i32 = 0x8898_2F60_u32 as i32;
pub(crate) const WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT: i32 = 0x8898_2F80_u32 as i32;
pub(crate) const DXGI_ERROR_DEVICE_REMOVED: i32 = 0x887A_0005_u32 as i32;

const COM_UNINITIALIZED_SUGGESTION: &str =
    "Join the calling thread to the COM multithreaded apartment before observing the desktop";

/// The read-path classification the resolution retry loop consumes: whether a failed
/// read is a settled absence, a transient transport failure, a vanished
/// element, or a terminal error the attempt must surface as-is.
///
/// The three classes are the `kAXErrorIllegalArgument` lesson ported to
/// Windows (`crates/macos/src/system/window/window_bridge.rs:54-103`): a
/// structurally-impossible answer - the element genuinely lacks the attribute,
/// the window genuinely has no match - is a **settled absence, never
/// retryable**; conflating it with a transport failure burns the whole budget
/// retrying what cannot succeed. Retryable transport turns the attempt
/// incomplete within its deadline; a vanished element is the granularity case
/// (`UIA_E_ELEMENTNOTAVAILABLE`) that settles as stale only for a read of the
/// resolved target and marks a mid-descent node incomplete instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadDisposition {
    /// Structurally impossible: the provider answered that the property or
    /// pattern does not exist, or the request could not be a valid read.
    /// Settled, never retried.
    SettledAbsence,
    /// Transport, timeout, or a provider that changed under the read:
    /// retryable within the operation's deadline.
    Retryable,
    /// The element is unavailable: stale for the resolved target, incomplete
    /// for a node vanishing mid-descent.
    Unavailable,
    /// A hard failure with no defined recovery (denial, unknown code).
    Terminal,
}

impl ReadDisposition {
    /// The typed channel pair the resolution loop and core's hydration read: a settled
    /// absence or terminal failure is complete and never retried; transport
    /// and a vanished element are incomplete and retryable within the
    /// deadline.
    pub(crate) fn retry_details(self) -> (bool, bool) {
        match self {
            ReadDisposition::SettledAbsence | ReadDisposition::Terminal => (true, false),
            ReadDisposition::Retryable | ReadDisposition::Unavailable => (false, true),
        }
    }
}

/// One HRESULT's complete classification, named exactly once: the read-path
/// `ReadDisposition` the resolution retry loop drives on, the `ErrorCode` a
/// caller-facing error carries, and an optional recovery hint.
///
/// `classify_read_hresult` and `automation_classify.rs`'s `hresult_disposition`
/// are both one-line projections of `hresult_record` rather than separate
/// matches, so a code cannot be classified one way for retry and a different
/// way for the error surfaced to a caller.
pub(crate) struct HresultRecord {
    pub(crate) disposition: ReadDisposition,
    pub(crate) code: ErrorCode,
    pub(crate) suggestion: Option<&'static str>,
}

/// Names every HRESULT this crate's read paths raise, exactly once.
///
/// An unlisted code is `Terminal`/`ErrorCode::Internal` - the loop retries
/// only what is marked retryable, so an unknown failure surfaces rather than
/// being guessed.
///
/// `E_UNEXPECTED` is listed, and retryable, on purpose. A provider whose window
/// or host is tearing down answers a read with it while the target changes
/// under the read, not because the read is malformed, so the next poll finds
/// the window gone or reads the settled provider. Every loop that consumes the
/// retryable stamp is bounded by its caller's deadline, so a provider that
/// answers it forever costs that budget and then surfaces the error unchanged.
///
/// Three codes are unlisted on purpose, because each reads like an oversight
/// and is not.
///
/// `S_OK` cannot arrive here from an enumeration. `uiautomation::Error::result`
/// answers `Some` only for a negative code, and `UiaFailure::Hresult` is built
/// only on that `Some`, so a null interface out-param - the end-of-list signal,
/// which `windows-core` reports as `Error::empty()` carrying `HRESULT(0)` -
/// splits onto the sentinel branch as `ERR_NONE` and is read as exhaustion,
/// never as a classified failure. The one path that can reach this arm with
/// `S_OK` is the client bootstrap, where `CoCreateInstance` reported success
/// and handed back a null interface; that is a broken class factory, and
/// terminal is the honest answer.
///
/// `UIA_E_NOCLICKABLEPOINT` is not a settled absence. The conditions Microsoft
/// documents for it - the element obscured by another window or element, or not
/// scrolled fully into view - are view state a caller can change, unlike a
/// provider that genuinely lacks a property. It is also not how the client API
/// reports that absence: `GetClickablePoint` answers `S_OK` with a `FALSE`
/// out-param, which surfaces as a successful "no point" rather than as an error
/// at all.
///
/// `UIA_E_PROXYASSEMBLYNOTLOADED` reports that a client-side proxy provider's
/// assembly failed to load. That is this process's UI Automation stack failing,
/// not an answer about the target, and no retry this crate can run changes it.
pub(crate) fn hresult_record(hresult: i32) -> HresultRecord {
    match hresult {
        E_ACCESSDENIED => HresultRecord {
            disposition: ReadDisposition::Terminal,
            code: ErrorCode::PermDenied,
            suggestion: None,
        },
        CO_E_NOTINITIALIZED => HresultRecord {
            disposition: ReadDisposition::Terminal,
            code: ErrorCode::Internal,
            suggestion: Some(COM_UNINITIALIZED_SUGGESTION),
        },
        E_INVALIDARG | E_POINTER => HresultRecord {
            disposition: ReadDisposition::SettledAbsence,
            code: ErrorCode::InvalidArgs,
            suggestion: None,
        },
        UIA_E_ELEMENTNOTAVAILABLE => HresultRecord {
            disposition: ReadDisposition::Unavailable,
            code: ErrorCode::StaleRef,
            suggestion: None,
        },
        UIA_E_ELEMENTNOTENABLED => HresultRecord {
            disposition: ReadDisposition::Terminal,
            code: ErrorCode::ActionFailed,
            suggestion: None,
        },
        UIA_E_NOTSUPPORTED => HresultRecord {
            disposition: ReadDisposition::SettledAbsence,
            code: ErrorCode::ActionNotSupported,
            suggestion: None,
        },
        UIA_E_TIMEOUT => HresultRecord {
            disposition: ReadDisposition::Retryable,
            code: ErrorCode::Timeout,
            suggestion: None,
        },
        UIA_E_INVALIDOPERATION => HresultRecord {
            disposition: ReadDisposition::Terminal,
            code: ErrorCode::ActionFailed,
            suggestion: None,
        },
        RPC_E_DISCONNECTED
        | RPC_E_SERVERFAULT
        | RPC_S_SERVER_UNAVAILABLE
        | RPC_S_CALL_FAILED
        | E_UNEXPECTED => HresultRecord {
            disposition: ReadDisposition::Retryable,
            code: ErrorCode::AppUnresponsive,
            suggestion: None,
        },
        WINCODEC_ERR_BADIMAGE | WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT => HresultRecord {
            disposition: ReadDisposition::Terminal,
            code: ErrorCode::InvalidArgs,
            suggestion: None,
        },
        WINCODEC_ERR_COMPONENTNOTFOUND => HresultRecord {
            disposition: ReadDisposition::Terminal,
            code: ErrorCode::Internal,
            suggestion: None,
        },
        DXGI_ERROR_DEVICE_REMOVED => HresultRecord {
            disposition: ReadDisposition::Retryable,
            code: ErrorCode::ActionFailed,
            suggestion: None,
        },
        _ => HresultRecord {
            disposition: ReadDisposition::Terminal,
            code: ErrorCode::Internal,
            suggestion: None,
        },
    }
}

/// Classifies a named read-path HRESULT onto the three-state disposition.
///
/// A one-line projection of `hresult_record`; see that function for the named
/// table.
pub(crate) fn classify_read_hresult(hresult: i32) -> ReadDisposition {
    hresult_record(hresult).disposition
}

/// Renders an HRESULT for `platform_detail`.
///
/// Shape only: a code and, where one is known, its symbol and meaning. No
/// entry derives from an observed application.
pub(crate) fn com_hresult_detail(hresult: i32) -> String {
    let code = hresult as u32;
    match com_hresult_symbol(hresult) {
        Some((symbol, meaning)) => format!("COM HRESULT 0x{code:08X} ({symbol}: {meaning})"),
        None => format!("COM HRESULT 0x{code:08X}"),
    }
}

/// An HRESULT read through [`hresult_record`] and rendered as the
/// `AdapterError` its caller reports, `subsystem` naming the COM layer that
/// raised it (`"D3D"`, `"WGC"`, `"WIC"`, ...) so classification stays driven
/// by the one shared table this module exists to centralize, never
/// re-derived per subsystem.
pub(crate) fn hresult_error(subsystem: &str, hresult: i32, context: &str) -> AdapterError {
    let record = hresult_record(hresult);
    let mut error = AdapterError::new(record.code, format!("{subsystem} could not {context}"))
        .with_platform_detail(com_hresult_detail(hresult));
    if let Some(suggestion) = record.suggestion {
        error = error.with_suggestion(suggestion);
    }
    error
}

/// Names the HRESULTs this crate's COM paths can raise.
///
/// An unlisted code formats as a bare hexadecimal value rather than being
/// guessed at.
pub(crate) fn com_hresult_symbol(hresult: i32) -> Option<(&'static str, &'static str)> {
    let symbol = match hresult {
        E_ACCESSDENIED => ("E_ACCESSDENIED", "Access is denied"),
        E_NOINTERFACE => ("E_NOINTERFACE", "No such interface supported"),
        E_POINTER => ("E_POINTER", "Invalid pointer"),
        E_FAIL => ("E_FAIL", "Unspecified failure"),
        E_UNEXPECTED => ("E_UNEXPECTED", "Catastrophic failure"),
        E_INVALIDARG => ("E_INVALIDARG", "One or more arguments are invalid"),
        CO_E_NOTINITIALIZED => ("CO_E_NOTINITIALIZED", "COM has not been initialized"),
        RPC_E_SERVERFAULT => ("RPC_E_SERVERFAULT", "The server raised an exception"),
        RPC_E_DISCONNECTED => ("RPC_E_DISCONNECTED", "The object invoked has disconnected"),
        RPC_S_SERVER_UNAVAILABLE => ("RPC_S_SERVER_UNAVAILABLE", "The RPC server is unavailable"),
        RPC_S_CALL_FAILED => ("RPC_S_CALL_FAILED", "The remote procedure call failed"),
        UIA_E_ELEMENTNOTENABLED => ("UIA_E_ELEMENTNOTENABLED", "The element is not enabled"),
        UIA_E_ELEMENTNOTAVAILABLE => ("UIA_E_ELEMENTNOTAVAILABLE", "The element is not available"),
        UIA_E_NOCLICKABLEPOINT => (
            "UIA_E_NOCLICKABLEPOINT",
            "The element has no clickable point",
        ),
        UIA_E_PROXYASSEMBLYNOTLOADED => (
            "UIA_E_PROXYASSEMBLYNOTLOADED",
            "The proxy assembly could not be loaded",
        ),
        UIA_E_NOTSUPPORTED => (
            "UIA_E_NOTSUPPORTED",
            "The requested operation is unsupported",
        ),
        UIA_E_TIMEOUT => ("UIA_E_TIMEOUT", "The operation timed out"),
        UIA_E_INVALIDOPERATION => ("UIA_E_INVALIDOPERATION", "The operation is not valid"),
        WINCODEC_ERR_COMPONENTNOTFOUND => (
            "WINCODEC_ERR_COMPONENTNOTFOUND",
            "The imaging component was not found",
        ),
        WINCODEC_ERR_BADIMAGE => ("WINCODEC_ERR_BADIMAGE", "The image is unrecognized"),
        WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT => (
            "WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT",
            "The bitmap pixel format is unsupported",
        ),
        DXGI_ERROR_DEVICE_REMOVED => (
            "DXGI_ERROR_DEVICE_REMOVED",
            "The GPU device has been removed",
        ),
        _ => return None,
    };
    Some(symbol)
}

/// `HRESULT_FROM_WIN32` — the measured path for Win32 codes into the one
/// HRESULT table (A21-8).
pub(crate) fn hresult_from_win32(error: u32) -> i32 {
    if error == 0 {
        0
    } else if (error as i32) < 0 {
        error as i32
    } else {
        ((error & 0xFFFF) | 0x8007_0000) as i32
    }
}

/// A Win32 error code rendered through the one HRESULT table.
#[cfg(target_os = "windows")]
pub(crate) fn adapter_error_from_win32(error: u32, message: &str) -> AdapterError {
    let hresult = hresult_from_win32(error);
    let record = hresult_record(hresult);
    let mut err =
        AdapterError::new(record.code, message).with_platform_detail(com_hresult_detail(hresult));
    if let Some(suggestion) = record.suggestion {
        err = err.with_suggestion(suggestion);
    }
    err
}

/// Win32 `GetLastError` → `HRESULT_FROM_WIN32` into the shared HRESULT table
/// (A21-8).
#[cfg(target_os = "windows")]
pub(crate) fn win32_last_error(message: &str) -> AdapterError {
    let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
    adapter_error_from_win32(error, message)
}

#[cfg(test)]
#[path = "hresult_tests.rs"]
mod tests;

/// Split from `hresult_tests.rs`, which sits near the per-file line cap: this
/// module owns the symbol table's pins, which are a different subject from the
/// classification arms - the text an operator reads rather than the retry
/// verdict the loop drives on.
#[cfg(test)]
#[path = "hresult_symbol_tests.rs"]
mod symbol_tests;
