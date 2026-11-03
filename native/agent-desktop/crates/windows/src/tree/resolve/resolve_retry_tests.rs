//! The deadline retry loop's own tests: settled never retries, incomplete
//! retries within budget, and expiry carries the last diagnosis.

use super::*;
use crate::system::fixture::test_time::deadline;
use crate::tree::test_support::unreachable_handle;
use agent_desktop_core::DeliverySemantics;

fn retryable_incomplete(message: &str) -> AdapterError {
    AdapterError::new(agent_desktop_core::ErrorCode::AppUnresponsive, message)
        .with_details(serde_json::json!({ "retryable": true, "complete": false }))
}

fn err_code(result: Result<NativeHandle, AdapterError>) -> ErrorCode {
    match result {
        Err(error) => error.code,
        Ok(_) => panic!("expected an error, got a resolved handle"),
    }
}

fn err_code_owned(result: Result<NativeHandle, AdapterError>) -> AdapterError {
    match result {
        Err(error) => error,
        Ok(_) => panic!("expected an error, got a resolved handle"),
    }
}

/// An incomplete attempt retries within its deadline and succeeds when the
/// underlying cause recovers - the tree stabilises after a vanishing
/// node, the fake recovers.
#[test]
fn an_incomplete_attempt_retries_and_succeeds_within_the_deadline() {
    let mut attempts = 0;
    let deadline = deadline(5_000);
    let result = retry_incomplete_until(deadline, || {
        attempts += 1;
        if attempts < 3 {
            Err(retryable_incomplete("transient"))
        } else {
            Ok(unreachable_handle())
        }
    });
    assert!(result.is_ok());
    assert_eq!(attempts, 3);
}

/// A settled non-match (a completed search that finds nothing) is never
/// retried - the call-count pin fails if the classification is loosened.
#[test]
fn a_settled_non_match_never_retries() {
    let mut attempts = 0;
    let deadline = deadline(5_000);
    let result = retry_incomplete_until(deadline, || {
        attempts += 1;
        Err(AdapterError::new(
            ErrorCode::StaleRef,
            "Stored ref does not match any live element",
        )
        .with_suggestion("Run 'snapshot' to refresh, then retry with the updated ref.")
        .with_disposition(DeliverySemantics::not_delivered())
        .with_details(serde_json::json!({ "complete": true, "retryable": true })))
    });
    assert_eq!(err_code(result), agent_desktop_core::ErrorCode::StaleRef);
    assert_eq!(attempts, 1);
}

/// An unresponsive error that was not stamped retryable is not retried: the
/// loop's `is_retryable_resolution_error` requires the explicit stamp, so a
/// raw transport error terminates rather than burning the budget guessing.
#[test]
fn an_unstamped_unresponsive_error_is_not_retried() {
    let mut attempts = 0;
    let deadline = deadline(5_000);
    let result = retry_incomplete_until(deadline, || {
        attempts += 1;
        Err(AdapterError::new(
            agent_desktop_core::ErrorCode::AppUnresponsive,
            "raw",
        ))
    });
    assert_eq!(
        err_code(result),
        agent_desktop_core::ErrorCode::AppUnresponsive
    );
    assert_eq!(attempts, 1);
}

/// Deadline expiry mid-incompleteness returns the last incomplete
/// diagnosis stamped `deadline_elapsed`, not a bare `TIMEOUT` that
/// discards the diagnosis.
#[test]
fn deadline_expiry_mid_incompleteness_returns_the_last_diagnosis_stamped() {
    let deadline = deadline(200);
    let result = retry_incomplete_until(deadline, || Err(retryable_incomplete("stuck")));
    let error = err_code_owned(result);
    assert_eq!(error.code, agent_desktop_core::ErrorCode::AppUnresponsive);
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("deadline_elapsed"))
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );
}

/// A deadline that has already run out returns the plain timeout without
/// running the operation at all - there is no diagnosis to surface and no
/// attempt to attribute one to.
#[test]
fn an_already_expired_deadline_returns_the_plain_timeout_without_running_the_operation() {
    let mut attempts = 0;
    let result = retry_incomplete_until(deadline(0), || {
        attempts += 1;
        Ok(unreachable_handle())
    });
    let error = err_code_owned(result);
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
    assert_eq!(attempts, 0, "an expired deadline must not start an attempt");
    assert!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("deadline_elapsed"))
            .is_none(),
        "with no earlier diagnosis there is nothing to stamp deadline_elapsed onto"
    );
}

/// A `Timeout` the operation itself reports, with no earlier incomplete
/// diagnosis, passes through unstamped.
#[test]
fn an_operation_reported_timeout_with_nothing_earlier_passes_through_unstamped() {
    let deadline = deadline(200);
    let result = retry_incomplete_until(deadline, || {
        Err(AdapterError::new(
            agent_desktop_core::ErrorCode::Timeout,
            "gone",
        ))
    });
    let error = err_code_owned(result);
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
    assert!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("deadline_elapsed"))
            .is_none()
    );
}

/// The deadline stamp and the typed details fields are the only places a
/// marker survives; message and `platform_detail` stay clean.
#[test]
fn the_deadline_stamp_leaks_no_marker_into_message_or_platform_detail() {
    let error = AdapterError::new(
        agent_desktop_core::ErrorCode::AppUnresponsive,
        "Strict resolution could not determine candidate identity",
    )
    .with_platform_detail("com-hresult-shape")
    .with_details(serde_json::json!({
        "kind": "resolution_identity_unknown",
        "secret_slot": "MARKER-9f2c",
        "complete": false,
        "retryable": true,
    }));

    let stamped = mark_deadline_elapsed(error);
    assert!(!stamped.message.contains("MARKER-9f2c"));
    assert!(
        !stamped
            .platform_detail
            .unwrap_or_default()
            .contains("MARKER-9f2c")
    );
    let details = stamped.details.expect("details preserved");
    assert_eq!(
        details
            .get("secret_slot")
            .and_then(serde_json::Value::as_str),
        Some("MARKER-9f2c")
    );
    assert_eq!(
        details
            .get("deadline_elapsed")
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );
}

fn entry_with_hash(bounds_hash: Option<u64>) -> RefEntry {
    let mut entry = crate::tree::walk::walker_fake::ref_entry("button");
    entry.geometry.bounds_hash = bounds_hash;
    entry.scope.path_is_absolute = true;
    entry
}

/// A sole match found while another region of the tree was unreadable must
/// not resolve - the search is not yet conclusive, and the true target (or a
/// second candidate that would make it ambiguous) could be sitting in the
/// unread part. Fails against the pre-fix ordering, which consulted
/// `incomplete` only in the zero-candidate arm.
#[test]
fn one_match_with_an_incomplete_region_is_retried_not_resolved() {
    let entry = entry_with_hash(None);
    let verdict = classify_search(&[None], true, &entry);
    assert!(matches!(verdict, SearchVerdict::Incomplete));
}

/// The same sole match resolves once the search completed without anything
/// left unread.
#[test]
fn one_match_with_a_complete_search_resolves() {
    let entry = entry_with_hash(None);
    let verdict = classify_search(&[None], false, &entry);
    assert!(matches!(verdict, SearchVerdict::Resolved(0)));
}

/// Two or more matches with no stored hash to disambiguate is conclusively
/// ambiguous already, so an incomplete region elsewhere must not withhold
/// that verdict: nothing left unread could turn it into anything but
/// `AMBIGUOUS_TARGET`. Guards that gating resolution on `incomplete` does
/// not also gate this already-settled case.
#[test]
fn two_matches_with_no_hash_classify_as_ambiguous_even_when_incomplete() {
    let entry = entry_with_hash(None);
    let verdict = classify_search(&[None, None], true, &entry);
    assert!(matches!(verdict, SearchVerdict::Ambiguous));
}

/// A 2+-candidate case with a stored hash never reaches the early-stop
/// threshold (`should_stop_collecting` requires no stored hash), so an
/// incomplete region still withholds the verdict rather than tie-breaking
/// on a partial candidate set.
#[test]
fn two_matches_with_a_stored_hash_and_an_incomplete_region_are_retried() {
    let entry = entry_with_hash(Some(0xAAAA));
    let verdict = classify_search(&[Some(0xAAAA), Some(0xBBBB)], true, &entry);
    assert!(matches!(verdict, SearchVerdict::Incomplete));
}

/// The 2+-candidate tie-break still classifies normally - resolving on the
/// sole hash match - once the search is complete, even though a stored hash
/// was present and the early-stop threshold was never reached.
#[test]
fn two_matches_with_a_stored_hash_and_a_complete_search_still_classify() {
    let entry = entry_with_hash(Some(0xAAAA));
    let resolved = classify_search(&[Some(0xAAAA), Some(0xBBBB)], false, &entry);
    assert!(matches!(resolved, SearchVerdict::Resolved(0)));

    let ambiguous = classify_search(&[Some(0xAAAA), Some(0xAAAA)], false, &entry);
    assert!(matches!(ambiguous, SearchVerdict::Ambiguous));
}

/// An entry with no id, no stable text, and no positive-area bounds hash can
/// never be verified by any tier. The fixture's secure password control
/// structurally withholds its name, value, and description even on a fully
/// successful read - a genuine live candidate that core's identity matcher
/// can only ever report `Unknown` against. A stored ref that also carries no
/// distinguishing geometry can never settle a match against it, so
/// `resolve_attempt` must settle `STALE_REF` in exactly one attempt rather
/// than searching this tree and burning the retry budget on a candidate
/// that reads back `Unknown` every time.
#[test]
fn a_structurally_unverifiable_entry_settles_stale_in_one_attempt() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
    let deadline = crate::tree::walk::walker_fake::deadline();
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline)
        .expect("the fixture window resolves");
    let source = UiaTreeSource::for_root(&root).expect("a tree source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let budget = WalkBudget::new(10, deadline);
    let found = find_password(&source, &prepared, &budget)
        .expect("the fixture walk succeeds")
        .expect("a secure password element exists");
    let (_, _, evidence, _) = found;
    let role = evidence.role.known().cloned().unwrap_or_default();

    let token = crate::system::process_identity::token_for_pid(
        agent_desktop_core::ProcessId::from(fixture.process_id()),
    )
    .unwrap()
    .expect("a live fixture process has a token");

    let mut entry = crate::tree::walk::walker_fake::ref_entry(&role);
    entry.process = agent_desktop_core::RefProcess {
        pid: agent_desktop_core::ProcessId::from(fixture.process_id()),
        process_instance: Some(token),
    };
    entry.source.source_app = Some("fixture.exe".into());
    entry.source.source_window_id = Some(format!("w-{}", fixture.handle()));

    assert!(
        crate::tree::resolve::resolve_search::entry_is_unverifiable(&entry),
        "id-less, textless, geometry-less entry must be structurally unverifiable"
    );

    let mut attempts = 0;
    let result = retry_incomplete_until(deadline, || {
        attempts += 1;
        resolve_attempt(&entry, deadline)
    });

    assert_eq!(
        attempts, 1,
        "a structurally unverifiable entry must settle in one attempt, never retry-burn"
    );
    match result {
        Err(error) => assert_eq!(error.code, agent_desktop_core::ErrorCode::StaleRef),
        Ok(_) => panic!("an unverifiable entry must not resolve to a live element"),
    }
}
