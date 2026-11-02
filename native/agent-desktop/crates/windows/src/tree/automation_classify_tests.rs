use super::{
    ERR_ALREADY_RUNNING, ERR_FORMAT, ERR_INACTIVE, ERR_INVALID_ARG, ERR_INVALID_OBJECT, ERR_NONE,
    ERR_NOTFOUND, ERR_NULL_PTR, ERR_TIMEOUT, ERR_TYPE, ErrorCode, ReadDisposition,
    UIA_E_ELEMENTNOTAVAILABLE, UiaFailure, root_resolution_error, sentinel_disposition,
    sentinel_record, uia_failure_disposition, uia_failure_error,
};

#[test]
fn a_vanished_elements_sentinel_pairs_stale_ref_with_the_unavailable_disposition() {
    let record = sentinel_record(ERR_INVALID_OBJECT);
    assert_eq!(record.code, ErrorCode::StaleRef);
    assert_eq!(record.disposition, ReadDisposition::Unavailable);
}

/// Every sentinel's classification as a person decided it, written out as
/// literals rather than read back out of the table under test.
///
/// The retry stamp is stated as the `complete`/`retryable` pair a caller
/// receives rather than as a restatement of the disposition, so flipping
/// either an arm's disposition or `ReadDisposition::retry_details`
/// changes the answer while this expectation stays put. Comparing the
/// public projections against `sentinel_record` instead would assert
/// nothing at all: each projection is defined as that record's field, so
/// the comparison holds for every possible table.
struct ExpectedSentinel {
    sentinel: i32,
    code: ErrorCode,
    disposition: ReadDisposition,
    complete: bool,
    retryable: bool,
}

fn expected_sentinels() -> Vec<ExpectedSentinel> {
    vec![
        ExpectedSentinel {
            sentinel: ERR_NOTFOUND,
            code: ErrorCode::ElementNotFound,
            disposition: ReadDisposition::Unavailable,
            complete: false,
            retryable: true,
        },
        ExpectedSentinel {
            sentinel: ERR_NULL_PTR,
            code: ErrorCode::ElementNotFound,
            disposition: ReadDisposition::Terminal,
            complete: true,
            retryable: false,
        },
        ExpectedSentinel {
            sentinel: ERR_TIMEOUT,
            code: ErrorCode::Timeout,
            disposition: ReadDisposition::Retryable,
            complete: false,
            retryable: true,
        },
        ExpectedSentinel {
            sentinel: ERR_INACTIVE,
            code: ErrorCode::AppUnresponsive,
            disposition: ReadDisposition::Retryable,
            complete: false,
            retryable: true,
        },
        ExpectedSentinel {
            sentinel: ERR_INVALID_OBJECT,
            code: ErrorCode::StaleRef,
            disposition: ReadDisposition::Unavailable,
            complete: false,
            retryable: true,
        },
        ExpectedSentinel {
            sentinel: ERR_INVALID_ARG,
            code: ErrorCode::InvalidArgs,
            disposition: ReadDisposition::SettledAbsence,
            complete: true,
            retryable: false,
        },
        ExpectedSentinel {
            sentinel: ERR_NONE,
            code: ErrorCode::Internal,
            disposition: ReadDisposition::Terminal,
            complete: true,
            retryable: false,
        },
        ExpectedSentinel {
            sentinel: ERR_TYPE,
            code: ErrorCode::Internal,
            disposition: ReadDisposition::Terminal,
            complete: true,
            retryable: false,
        },
        ExpectedSentinel {
            sentinel: ERR_FORMAT,
            code: ErrorCode::Internal,
            disposition: ReadDisposition::Terminal,
            complete: true,
            retryable: false,
        },
        ExpectedSentinel {
            sentinel: ERR_ALREADY_RUNNING,
            code: ErrorCode::Internal,
            disposition: ReadDisposition::Terminal,
            complete: true,
            retryable: false,
        },
    ]
}

#[test]
fn every_sentinel_carries_the_classification_a_person_decided_for_it() {
    for expected in expected_sentinels() {
        let sentinel = expected.sentinel;
        let record = sentinel_record(sentinel);
        assert_eq!(
            record.code, expected.code,
            "sentinel {sentinel} record code"
        );
        assert_eq!(
            record.disposition, expected.disposition,
            "sentinel {sentinel} record disposition"
        );
        assert_eq!(
            record.disposition.retry_details(),
            (expected.complete, expected.retryable),
            "sentinel {sentinel} complete/retryable pair"
        );
        assert_eq!(
            sentinel_disposition(sentinel),
            expected.code,
            "sentinel {sentinel} public code projection"
        );
        assert_eq!(
            uia_failure_disposition(UiaFailure::Sentinel(sentinel)),
            expected.disposition,
            "sentinel {sentinel} public disposition projection"
        );

        let error = uia_failure_error(UiaFailure::Sentinel(sentinel), "read a property");
        assert_eq!(
            error.code, expected.code,
            "sentinel {sentinel} surfaced code"
        );
        assert_eq!(
            error.is_explicitly_retryable(),
            expected.retryable,
            "sentinel {sentinel} surfaced retryability"
        );
    }
}

/// The table above must name every sentinel the crate classifies, so an
/// arm added to `sentinel_record` cannot ship unpinned.
#[test]
fn the_expectation_table_covers_every_named_sentinel() {
    let named = [
        ERR_NOTFOUND,
        ERR_NULL_PTR,
        ERR_TIMEOUT,
        ERR_INACTIVE,
        ERR_INVALID_OBJECT,
        ERR_INVALID_ARG,
        ERR_NONE,
        ERR_TYPE,
        ERR_FORMAT,
        ERR_ALREADY_RUNNING,
    ];
    let expectations = expected_sentinels();
    assert!(
        !expectations.is_empty(),
        "an empty table would satisfy the per-arm assertions vacuously"
    );
    for sentinel in named {
        assert!(
            expectations
                .iter()
                .any(|expected| expected.sentinel == sentinel),
            "sentinel {sentinel} has no stated expectation"
        );
    }
    assert_eq!(expectations.len(), named.len());
}

/// The consequence, not the payload. Every core retry consumer keys on the
/// typed retryability `with_details` derives from the `retryable` key, so
/// a rewritten error that carries no details reads as retry-permitting and
/// sends a caller polling a window that is gone. Asserting a key exists
/// would pass on a wrong value; these assert what the gate answers.
#[test]
fn a_missing_window_root_settles_rather_than_permitting_a_pointless_retry() {
    for failure in [
        UiaFailure::Hresult(UIA_E_ELEMENTNOTAVAILABLE),
        UiaFailure::Sentinel(ERR_NOTFOUND),
    ] {
        let error = root_resolution_error(failure);

        assert_eq!(error.code, ErrorCode::WindowNotFound);
        assert!(
            !error.is_explicitly_retryable(),
            "a window that is gone must not be marked retryable"
        );
        assert!(
            !error.permits_retry_by_default(),
            "an unstamped rewrite reads as retry-permitting; the stamp must deny it"
        );
    }
}

/// The rewrite is narrow: a root failure that is not a missing window is
/// passed through with the disposition its own record decided, so
/// re-stamping the missing-window branch cannot flatten the rest.
#[test]
fn a_root_failure_that_is_not_a_missing_window_keeps_its_own_retry_stamp() {
    let transport = root_resolution_error(UiaFailure::Sentinel(ERR_TIMEOUT));
    let settled = root_resolution_error(UiaFailure::Sentinel(ERR_INVALID_ARG));

    assert!(transport.is_explicitly_retryable());
    assert!(!settled.is_explicitly_retryable());
    assert!(!settled.permits_retry_by_default());
}

/// Exactly three failures answer "no match" for an optional-result read -
/// exhaustion and the vanished family - and every transport or terminal
/// fault must surface, because reading it as absence reports a confident
/// negative the caller cannot distinguish from a genuine empty region.
/// Flattening this predicate to blanket-absence is the invert that fails
/// here.
#[test]
fn exhaustion_and_the_vanished_family_are_absence_and_anything_else_is_a_fault() {
    use crate::system::runtime::hresult::UIA_E_TIMEOUT;

    assert!(UiaFailure::Sentinel(ERR_NONE).is_absence());
    assert!(UiaFailure::Sentinel(ERR_NOTFOUND).is_absence());
    assert!(UiaFailure::Hresult(UIA_E_ELEMENTNOTAVAILABLE).is_absence());

    assert!(!UiaFailure::Sentinel(ERR_TIMEOUT).is_absence());
    assert!(!UiaFailure::Hresult(UIA_E_TIMEOUT).is_absence());
    assert!(!UiaFailure::Sentinel(ERR_INVALID_OBJECT).is_absence());
    assert!(!UiaFailure::Sentinel(ERR_NULL_PTR).is_absence());
}
