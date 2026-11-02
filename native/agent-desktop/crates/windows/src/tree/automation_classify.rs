//! HRESULT/sentinel failure classification.
//!
//! Turns one UI Automation failure - whether a COM HRESULT or a
//! `uiautomation` crate sentinel - into a structured `AdapterError` carrying
//! the typed `complete`/`retryable` disposition the resolution retry loop and
//! core's hydration read off the details payload.
//!
//! Split from `automation.rs` to separate this classification table from the
//! automation-client bootstrap and bounded-root resolution it feeds
//! (`automation.rs`): the table grows every time a newly-observed HRESULT or
//! sentinel needs a mapping, while the client plumbing does not change with
//! it.
//!
//! Each code family is named exactly once. The HRESULT side is
//! `hresult::hresult_record` (`crates/windows/src/system/runtime/hresult.rs`); the
//! sentinel side is this module's own `sentinel_record`. Before this, one
//! code's read-path `ReadDisposition` and its caller-facing `ErrorCode` lived
//! in two separate matches that agreed only because both were edited by hand
//! together - `ERR_INVALID_OBJECT`'s `StaleRef`/`Unavailable` pairing was
//! never itself asserted anywhere. One record per code makes that pairing the
//! only thing that can be written down.

use agent_desktop_core::{AdapterError, ErrorCode};

use crate::system::runtime::hresult::{
    ReadDisposition, UIA_E_ELEMENTNOTAVAILABLE, classify_read_hresult, com_hresult_detail,
    hresult_record,
};

pub const ERR_NONE: i32 = 0;
pub const ERR_NOTFOUND: i32 = 1;
pub const ERR_TIMEOUT: i32 = 2;
pub const ERR_INACTIVE: i32 = 3;
pub const ERR_TYPE: i32 = 4;
pub const ERR_NULL_PTR: i32 = 5;
pub const ERR_FORMAT: i32 = 6;
pub const ERR_INVALID_OBJECT: i32 = 7;
pub const ERR_ALREADY_RUNNING: i32 = 8;
pub const ERR_INVALID_ARG: i32 = 9;

/// One UI Automation failure, already split on the discriminator the crate's
/// `Error` type mixes into a single `i32`.
///
/// `uiautomation::Error` carries its own non-negative sentinels (`ERR_NONE`,
/// `ERR_NOTFOUND`, …) in the same field as a real HRESULT, so `code()` alone
/// is ambiguous. `result()` is the only honest branch: `Some` for an HRESULT,
/// `None` for a crate sentinel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiaFailure {
    Hresult(i32),
    Sentinel(i32),
}

impl UiaFailure {
    /// Reports whether this failure is the benign end-of-list signal a child
    /// enumeration must not mistake for a fault.
    ///
    /// `windows-core` returns `Error::empty()` for a null interface out-param,
    /// whose `code()` is `HRESULT(0)`, which `uiautomation` stores verbatim.
    /// The runtime pair is measured by the CI capability probe rather than
    /// inferred from that chain.
    pub fn is_exhaustion(self) -> bool {
        matches!(self, UiaFailure::Sentinel(ERR_NONE))
    }

    /// Whether this failure answers "no match" rather than "the search could
    /// not run", for a read whose result is optional.
    ///
    /// `find_first` reports an empty region as exhaustion, and a subtree that
    /// raced away between discovery and the search reports the
    /// element-not-available family - both are absence semantics, the same
    /// answer a genuinely empty region gives, never a fault. Every other
    /// failure means the search itself could not run: mapping it to absence
    /// would dress a transient transport fault up as a confident negative,
    /// so such a failure must surface instead.
    pub fn is_absence(self) -> bool {
        self.is_exhaustion()
            || matches!(
                self,
                UiaFailure::Hresult(UIA_E_ELEMENTNOTAVAILABLE) | UiaFailure::Sentinel(ERR_NOTFOUND)
            )
    }
}

/// Builds a structured adapter error from a UI Automation failure.
///
/// `context` is a caller-supplied, shape-only phrase. Nothing observed from
/// the target — a property value, a `Name`, a `ClassName`, a window title, or
/// a `ProviderDescription` — may reach this function, because
/// `ref_action.rs` clones adapter error text into session trace segments.
///
/// Every error is stamped with the typed `complete`/`retryable` pair the
/// resolution retry loop and core's hydration read off the details payload
/// a settled absence or terminal failure is complete and never retried,
/// a transport failure or a vanished element is incomplete and retryable.
/// The disposition and the `ErrorCode` both trace back to the same record -
/// `hresult_record` or `sentinel_record` - so they can never come from
/// different facts about the same code, even though this function reaches
/// them through the thin, separately-testable projections below.
pub fn uia_failure_error(failure: UiaFailure, context: &str) -> AdapterError {
    let (complete, retryable) = uia_failure_disposition(failure).retry_details();
    let details = serde_json::json!({ "complete": complete, "retryable": retryable });
    match failure {
        UiaFailure::Hresult(hresult) => {
            let (code, suggestion) = hresult_disposition(hresult);
            let error = AdapterError::new(code, format!("UI Automation could not {context}"))
                .with_platform_detail(com_hresult_detail(hresult))
                .with_details(details);
            match suggestion {
                Some(hint) => error.with_suggestion(hint),
                None => error,
            }
        }
        UiaFailure::Sentinel(sentinel) => AdapterError::new(
            sentinel_disposition(sentinel),
            format!("UI Automation could not {context}"),
        )
        .with_platform_detail(format!("UI Automation client status {sentinel}"))
        .with_details(details),
    }
}

/// The read-path disposition of a UI Automation failure across both branches,
/// driving the `complete`/`retryable` stamp on `uia_failure_error`. The
/// HRESULT branch is `hresult::classify_read_hresult`, itself a one-line
/// projection of `hresult_record`; the sentinel branch reads
/// `sentinel_record` directly.
pub(crate) fn uia_failure_disposition(failure: UiaFailure) -> ReadDisposition {
    match failure {
        UiaFailure::Hresult(hresult) => classify_read_hresult(hresult),
        UiaFailure::Sentinel(sentinel) => sentinel_record(sentinel).disposition,
    }
}

/// A one-line projection of `hresult_record`, in the `(ErrorCode, suggestion)`
/// shape `uia_failure_error`'s HRESULT branch consumes.
fn hresult_disposition(hresult: i32) -> (ErrorCode, Option<&'static str>) {
    let record = hresult_record(hresult);
    (record.code, record.suggestion)
}

/// One `uiautomation` crate sentinel's complete classification, named exactly
/// once - the sentinel counterpart to `hresult::HresultRecord`.
struct SentinelRecord {
    code: ErrorCode,
    disposition: ReadDisposition,
}

/// Names every sentinel this crate's read paths raise, exactly once.
///
/// An unlisted code is `Terminal`/`ErrorCode::Internal`, the same default
/// `hresult_record` uses for an unnamed HRESULT.
fn sentinel_record(sentinel: i32) -> SentinelRecord {
    match sentinel {
        ERR_NOTFOUND => SentinelRecord {
            code: ErrorCode::ElementNotFound,
            disposition: ReadDisposition::Unavailable,
        },
        ERR_NULL_PTR => SentinelRecord {
            code: ErrorCode::ElementNotFound,
            disposition: ReadDisposition::Terminal,
        },
        ERR_TIMEOUT => SentinelRecord {
            code: ErrorCode::Timeout,
            disposition: ReadDisposition::Retryable,
        },
        ERR_INACTIVE => SentinelRecord {
            code: ErrorCode::AppUnresponsive,
            disposition: ReadDisposition::Retryable,
        },
        ERR_INVALID_OBJECT => SentinelRecord {
            code: ErrorCode::StaleRef,
            disposition: ReadDisposition::Unavailable,
        },
        ERR_INVALID_ARG => SentinelRecord {
            code: ErrorCode::InvalidArgs,
            disposition: ReadDisposition::SettledAbsence,
        },
        ERR_NONE | ERR_TYPE | ERR_FORMAT | ERR_ALREADY_RUNNING => SentinelRecord {
            code: ErrorCode::Internal,
            disposition: ReadDisposition::Terminal,
        },
        _ => SentinelRecord {
            code: ErrorCode::Internal,
            disposition: ReadDisposition::Terminal,
        },
    }
}

/// A one-line projection of `sentinel_record` onto its `ErrorCode`.
fn sentinel_disposition(sentinel: i32) -> ErrorCode {
    sentinel_record(sentinel).code
}

/// Rewrites a root-resolution failure so a window that no longer exists is
/// reported as a missing window rather than a stale element.
///
/// The rewrite re-stamps the `complete`/`retryable` pair from this module's
/// own disposition table rather than inheriting the replaced error's, because
/// changing the granularity changes the answer. At element granularity an
/// unavailable target is `ReadDisposition::Unavailable` - incomplete and worth
/// another attempt, since a descent may find it again. At window-root
/// granularity the same failure says the handle addresses no resolvable
/// window, and a destroyed window never answers the same handle again (A14-5):
/// that is `ReadDisposition::SettledAbsence`, and the suggestion says the same
/// thing in words, since recovery is a *new* handle rather than a repeat of
/// this call.
///
/// Carrying no stamp at all is the third answer and the wrong one.
/// `permits_retry_by_default` reads an unstamped error as retryable, so a
/// caller polling for a window to settle would spend its whole budget on a
/// window that is already gone.
pub fn root_resolution_error(failure: UiaFailure) -> AdapterError {
    let error = uia_failure_error(failure, "resolve a window root");
    match failure {
        UiaFailure::Hresult(UIA_E_ELEMENTNOTAVAILABLE) | UiaFailure::Sentinel(ERR_NOTFOUND) => {
            let (complete, retryable) = ReadDisposition::SettledAbsence.retry_details();
            AdapterError::new(
                ErrorCode::WindowNotFound,
                "UI Automation could not resolve a window root",
            )
            .with_platform_detail(error.platform_detail.unwrap_or_default())
            .with_suggestion("List windows again and retry with a current window handle")
            .with_details(serde_json::json!({
                "kind": "window_root_missing",
                "complete": complete,
                "retryable": retryable,
            }))
        }
        _ => error,
    }
}

/// Split into its own file so the sentinel table's expectations can be stated
/// as literals without pushing this module past the per-file line cap.
///
/// Those expectations are deliberately written out rather than read back from
/// `sentinel_record`. `sentinel_disposition` and `uia_failure_disposition`'s
/// sentinel branch are one-line projections of that record, so comparing a
/// projection against the record asserts `f(x) == f(x)` and holds for every
/// possible table - including one whose arms are wrong.
#[cfg(test)]
#[path = "automation_classify_tests.rs"]
mod tests;
