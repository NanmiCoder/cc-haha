use super::{
    CO_E_NOTINITIALIZED, E_ACCESSDENIED, E_FAIL, E_INVALIDARG, E_NOINTERFACE, E_POINTER,
    E_UNEXPECTED, RPC_E_DISCONNECTED, RPC_E_SERVERFAULT, RPC_S_CALL_FAILED,
    RPC_S_SERVER_UNAVAILABLE, ReadDisposition, S_OK, UIA_E_ELEMENTNOTAVAILABLE,
    UIA_E_ELEMENTNOTENABLED, UIA_E_INVALIDOPERATION, UIA_E_NOCLICKABLEPOINT, UIA_E_NOTSUPPORTED,
    UIA_E_PROXYASSEMBLYNOTLOADED, UIA_E_TIMEOUT, classify_read_hresult, hresult_record,
};
use crate::tree::automation::{
    ERR_INVALID_ARG, ERR_NOTFOUND, ERR_TIMEOUT, UiaFailure, root_resolution_error,
    uia_failure_disposition, uia_failure_error,
};
use agent_desktop_core::{AdapterError, ErrorCode};

const UNNAMED_HRESULT: i32 = 0x8000_4004_u32 as i32;

/// One arm's classification as a person decided it, written out here as
/// literals rather than read back out of the table under test.
///
/// The retry stamp is stated as the `complete`/`retryable` pair a caller
/// receives, not as a restatement of the disposition, so flipping either the
/// arm's disposition or `ReadDisposition::retry_details` changes the answer
/// while this expectation stays put.
struct ExpectedArm {
    disposition: ReadDisposition,
    code: ErrorCode,
    complete: bool,
    retryable: bool,
    carries_suggestion: bool,
}

fn stamp(error: &AdapterError) -> Option<(bool, bool)> {
    let details = error.details.as_ref()?;
    let complete = details.get("complete")?.as_bool()?;
    let retryable = details.get("retryable")?.as_bool()?;
    Some((complete, retryable))
}

/// Checks one HRESULT against a stated expectation on every surface the arm
/// feeds: the record itself, the read-path projection the retry loop drives
/// on, and the error a caller is handed.
fn assert_arm(hresult: i32, expected: ExpectedArm) {
    let record = hresult_record(hresult);
    assert_eq!(
        record.disposition, expected.disposition,
        "0x{hresult:08X} record disposition"
    );
    assert_eq!(record.code, expected.code, "0x{hresult:08X} record code");
    assert_eq!(
        record.suggestion.is_some(),
        expected.carries_suggestion,
        "0x{hresult:08X} suggestion presence"
    );
    assert_eq!(
        classify_read_hresult(hresult),
        expected.disposition,
        "0x{hresult:08X} read-path classification"
    );
    assert_eq!(
        record.disposition.retry_details(),
        (expected.complete, expected.retryable),
        "0x{hresult:08X} complete/retryable pair"
    );

    let error = uia_failure_error(UiaFailure::Hresult(hresult), "read a property");
    assert_eq!(error.code, expected.code, "0x{hresult:08X} surfaced code");
    assert_eq!(
        stamp(&error),
        Some((expected.complete, expected.retryable)),
        "0x{hresult:08X} surfaced stamp"
    );
    assert_eq!(
        error.is_explicitly_retryable(),
        expected.retryable,
        "0x{hresult:08X} surfaced retryability"
    );
}

/// A denial is terminal: nothing about retrying the same read from the same
/// process turns an access denial into a readable element, so the attempt is
/// complete and the caller is told the permission is missing.
#[test]
fn access_denied_is_a_terminal_permission_denial() {
    assert_arm(
        E_ACCESSDENIED,
        ExpectedArm {
            disposition: ReadDisposition::Terminal,
            code: ErrorCode::PermDenied,
            complete: true,
            retryable: false,
            carries_suggestion: false,
        },
    );
}

/// An uninitialized apartment is a defect in this process, not a property of
/// the target, so it is terminal and carries the one recovery hint in the
/// table.
#[test]
fn an_uninitialized_apartment_is_terminal_and_the_only_arm_with_a_hint() {
    assert_arm(
        CO_E_NOTINITIALIZED,
        ExpectedArm {
            disposition: ReadDisposition::Terminal,
            code: ErrorCode::Internal,
            complete: true,
            retryable: false,
            carries_suggestion: true,
        },
    );
    assert_eq!(
        hresult_record(CO_E_NOTINITIALIZED)
            .suggestion
            .map(|hint| hint.contains("multithreaded apartment")),
        Some(true)
    );
}

/// A malformed request is structurally impossible to satisfy: the read cannot
/// succeed on a later attempt, so it settles rather than burning the budget.
#[test]
fn a_malformed_request_is_a_settled_absence_on_both_of_its_codes() {
    for hresult in [E_INVALIDARG, E_POINTER] {
        assert_arm(
            hresult,
            ExpectedArm {
                disposition: ReadDisposition::SettledAbsence,
                code: ErrorCode::InvalidArgs,
                complete: true,
                retryable: false,
                carries_suggestion: false,
            },
        );
    }
}

/// A vanished element is the granularity case: incomplete and retryable so a
/// mid-descent disappearance can be re-walked, and stale for a read of the
/// resolved target.
#[test]
fn a_vanished_element_is_unavailable_and_stale_for_the_resolved_target() {
    assert_arm(
        UIA_E_ELEMENTNOTAVAILABLE,
        ExpectedArm {
            disposition: ReadDisposition::Unavailable,
            code: ErrorCode::StaleRef,
            complete: false,
            retryable: true,
            carries_suggestion: false,
        },
    );
}

/// A disabled element answered the request: the provider is present and said
/// no, so the attempt is complete and the failure is the action's, not the
/// transport's.
#[test]
fn a_disabled_element_is_a_terminal_action_failure() {
    assert_arm(
        UIA_E_ELEMENTNOTENABLED,
        ExpectedArm {
            disposition: ReadDisposition::Terminal,
            code: ErrorCode::ActionFailed,
            complete: true,
            retryable: false,
            carries_suggestion: false,
        },
    );
}

/// The provider genuinely lacks the property or pattern; retrying asks the
/// same question of the same provider, so this settles.
#[test]
fn an_unsupported_request_is_a_settled_absence_never_retried() {
    assert_arm(
        UIA_E_NOTSUPPORTED,
        ExpectedArm {
            disposition: ReadDisposition::SettledAbsence,
            code: ErrorCode::ActionNotSupported,
            complete: true,
            retryable: false,
            carries_suggestion: false,
        },
    );
}

/// A timed-out cross-process call may well answer on the next attempt within
/// the deadline, so it is incomplete and retryable.
#[test]
fn a_timed_out_call_is_retryable_within_the_deadline() {
    assert_arm(
        UIA_E_TIMEOUT,
        ExpectedArm {
            disposition: ReadDisposition::Retryable,
            code: ErrorCode::Timeout,
            complete: false,
            retryable: true,
            carries_suggestion: false,
        },
    );
}

/// An invalid operation is the provider rejecting the call outright, which
/// the next identical call would reject identically.
#[test]
fn an_invalid_operation_is_a_terminal_action_failure() {
    assert_arm(
        UIA_E_INVALIDOPERATION,
        ExpectedArm {
            disposition: ReadDisposition::Terminal,
            code: ErrorCode::ActionFailed,
            complete: true,
            retryable: false,
            carries_suggestion: false,
        },
    );
}

/// A provider that answers a read with `E_UNEXPECTED` is mid-transition - a
/// window or host tearing down under the read - so the failure is incomplete
/// and retryable as an unresponsive app rather than terminal and internal.
/// Terminal would end a deadline-bounded poll on the first read that raced a
/// teardown.
#[test]
fn a_catastrophic_provider_failure_is_retryable_as_an_unresponsive_app() {
    assert_arm(
        E_UNEXPECTED,
        ExpectedArm {
            disposition: ReadDisposition::Retryable,
            code: ErrorCode::AppUnresponsive,
            complete: false,
            retryable: true,
            carries_suggestion: false,
        },
    );
}

/// Every RPC transport failure is one fact about the channel, not about the
/// element: incomplete, retryable, and surfaced as an unresponsive app.
#[test]
fn every_rpc_transport_failure_is_retryable_as_an_unresponsive_app() {
    for hresult in [
        RPC_E_DISCONNECTED,
        RPC_E_SERVERFAULT,
        RPC_S_SERVER_UNAVAILABLE,
        RPC_S_CALL_FAILED,
    ] {
        assert_arm(
            hresult,
            ExpectedArm {
                disposition: ReadDisposition::Retryable,
                code: ErrorCode::AppUnresponsive,
                complete: false,
                retryable: true,
                carries_suggestion: false,
            },
        );
    }
}

/// The catch-all surfaces rather than guesses: an HRESULT nobody classified -
/// including the success code no failure path should reach - is terminal and
/// internal, so the retry loop never spends its budget on an unknown failure.
#[test]
fn an_unclassified_hresult_falls_through_to_a_terminal_internal_failure() {
    for hresult in [UNNAMED_HRESULT, E_FAIL, E_NOINTERFACE, S_OK] {
        assert_arm(
            hresult,
            ExpectedArm {
                disposition: ReadDisposition::Terminal,
                code: ErrorCode::Internal,
                complete: true,
                retryable: false,
                carries_suggestion: false,
            },
        );
    }
}

/// Two codes `com_hresult_symbol` names are left to the catch-all on purpose,
/// and the reading their names invite would be wrong for both.
///
/// `UIA_E_NOCLICKABLEPOINT` is not a settled absence. Microsoft documents its
/// causes as the element being obscured by another window or element, or not
/// scrolled fully into view - view state a later attempt can change, unlike a
/// provider that genuinely lacks a property. The client API does not report the
/// absence this way either: `GetClickablePoint` answers `S_OK` with a `FALSE`
/// out-param. Settling it would also flip the search descent from surfacing the
/// failure to reading that branch as a complete, empty child set.
///
/// `UIA_E_PROXYASSEMBLYNOTLOADED` reports a client-side proxy provider assembly
/// that failed to load: this process's own stack is broken, which is what
/// `Internal` says.
#[test]
fn the_two_named_uia_codes_stay_terminal_for_reasons_their_names_hide() {
    for hresult in [UIA_E_NOCLICKABLEPOINT, UIA_E_PROXYASSEMBLYNOTLOADED] {
        assert_arm(
            hresult,
            ExpectedArm {
                disposition: ReadDisposition::Terminal,
                code: ErrorCode::Internal,
                complete: true,
                retryable: false,
                carries_suggestion: false,
            },
        );
    }
}

/// The success code reaches the catch-all only from the client bootstrap, never
/// from a walk: an enumeration's end-of-list arrives as a null interface
/// out-param, and `uiautomation::Error::result` answers `Some` only for a
/// negative code, so it splits onto the sentinel branch instead of becoming
/// `Hresult(S_OK)`.
///
/// Asserted against the crate rather than against a reading of it. Were that
/// split to change, every exhausted sibling list would classify through the
/// catch-all and abort its walk as an internal failure.
#[cfg(target_os = "windows")]
#[test]
fn an_enumerations_end_of_list_never_classifies_through_the_success_catch_all() {
    let end_of_list = uiautomation::Error::from(windows::core::Error::empty());

    let failure = crate::tree::automation::failure_of(&end_of_list);

    assert_ne!(failure, UiaFailure::Hresult(S_OK));
    assert!(failure.is_exhaustion());
}

/// The sentinel table and the HRESULT table answer the same way for the same
/// condition.
///
/// The literal dispositions below say what each sentinel classifies as; the
/// cross-check says it is the *same* answer its HRESULT equivalent gets, which
/// is what the two tables existing side by side is a risk to. Without it, one
/// table could be re-classified alone and the retry loop would drive a
/// condition differently depending on which of the two ways the provider
/// happened to report it.
#[test]
fn the_sentinel_branches_classify_like_their_hresult_equivalents() {
    assert_eq!(
        uia_failure_disposition(UiaFailure::Sentinel(ERR_TIMEOUT)),
        ReadDisposition::Retryable
    );
    assert_eq!(
        uia_failure_disposition(UiaFailure::Sentinel(ERR_NOTFOUND)),
        ReadDisposition::Unavailable
    );
    assert_eq!(
        uia_failure_disposition(UiaFailure::Sentinel(ERR_INVALID_ARG)),
        ReadDisposition::SettledAbsence
    );

    for (sentinel, equivalent, condition) in [
        (ERR_TIMEOUT, UIA_E_TIMEOUT, "an operation that timed out"),
        (
            ERR_NOTFOUND,
            UIA_E_ELEMENTNOTAVAILABLE,
            "an element that is gone",
        ),
        (ERR_INVALID_ARG, E_INVALIDARG, "a structurally invalid read"),
    ] {
        assert_eq!(
            uia_failure_disposition(UiaFailure::Sentinel(sentinel)),
            uia_failure_disposition(UiaFailure::Hresult(equivalent)),
            "{condition} must classify the same whichever table reports it"
        );
    }
}

/// The A14-5 split is carried: at root resolution the vanished-window shape
/// stays `WINDOW_NOT_FOUND`, while the same HRESULT means a stale element on
/// the read path (the live-read path resolves the granularity at the target).
#[test]
fn the_vanished_element_split_keeps_root_resolution_as_window_not_found() {
    let failure = UiaFailure::Hresult(UIA_E_ELEMENTNOTAVAILABLE);
    assert_eq!(
        root_resolution_error(failure).code,
        ErrorCode::WindowNotFound
    );
}
