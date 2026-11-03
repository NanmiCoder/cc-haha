use super::*;
use agent_desktop_core::{
    DeliverySemantics, ElementIdentifier, ErrorCode, IdentifierEvidence, IdentifierKind,
    NodeDescriptor,
};

fn field(value: Option<&str>) -> LocatorField<String> {
    match value {
        Some(value) => LocatorField::Known(value.to_string()),
        None => LocatorField::Absent,
    }
}

fn evidence(
    name: Option<&str>,
    value: Option<&str>,
    description: Option<&str>,
    native_id: Option<&str>,
) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known("button".to_string()),
        name: field(name),
        value: field(value),
        description: field(description),
        identifiers: IdentifierEvidence::typed(
            native_id.into_iter().map(|value| ElementIdentifier {
                kind: IdentifierKind::AutomationId,
                value: value.to_string(),
            }),
            None,
            true,
        ),
        states: LocatorField::Absent,
        ref_evidence: agent_desktop_core::LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Absent,
            available_actions: LocatorField::Absent,
            descriptors: NodeDescriptor::default(),
        },
    }
}

fn entry(
    native: Option<&str>,
    role: &str,
    name: Option<&str>,
    value: Option<&str>,
    description: Option<&str>,
) -> RefEntry {
    let mut entry = crate::tree::walk::walker_fake::ref_entry(role);
    entry.identity.name = name.map(str::to_string);
    entry.identity.value = value.map(str::to_string);
    entry.identity.description = description.map(str::to_string);
    entry.identity.native_id = native.map(|value| ElementIdentifier {
        kind: IdentifierKind::AutomationId,
        value: value.to_string(),
    });
    entry
}

/// The A7-3 silent-wrong-target pin under the composed matcher: a
/// candidate sharing the stored `native_id` and role whose stable name
/// drifted is refuted, not matched. Weakening the corroboration to
/// id-only would let the wrong element resolve - the exact shape A7-3
/// measured on Explorer.
#[test]
fn a_matching_native_id_with_a_stable_name_drift_is_refuted() {
    let stored = entry(Some("row-77"), "row", Some("Alpha"), None, None);
    let drifted = evidence(Some("Beta"), None, None, Some("row-77"));

    assert_eq!(
        candidate_outcome(&stored, &drifted),
        CandidateOutcome::Refuted
    );
    let matching = evidence(Some("Alpha"), None, None, Some("row-77"));
    assert_eq!(
        candidate_outcome(&stored, &matching),
        CandidateOutcome::Matched
    );
}

/// A candidate whose stable-text field could not be read is **incomplete**,
/// never refuted - the test fails if `Unknown` is collapsed into `NoMatch`.
#[test]
fn an_unreadable_name_is_incomplete_not_a_mismatch() {
    let stored = entry(Some("btn-1"), "button", Some("Old Label"), None, None);
    let unreadable = LocatorEvidence {
        name: LocatorField::Unknown,
        ..evidence(None, None, None, Some("btn-1"))
    };

    assert_eq!(
        candidate_outcome(&stored, &unreadable),
        CandidateOutcome::Incomplete
    );
}

/// An id `Match` on a ref with no stored text identity (an icon-only
/// button) resolves without corroboration - the previous behaviour preserved.
#[test]
fn an_id_match_without_stored_text_resolves_without_corroboration() {
    let stored = entry(Some("icon-1"), "button", None, None, None);
    let live = evidence(None, None, None, Some("icon-1"));

    assert_eq!(candidate_outcome(&stored, &live), CandidateOutcome::Matched);
}

/// A mutable-value role whose name mirrors its current value has no stable
/// text identity by core's own `stable_name` rule (name == value is
/// dropped as volatile), so an id `Match` resolves without corroboration -
/// the prior pin, carried through core rather than re-implemented on Windows.
/// The realistic textfield shape: stored name and value agree, the live
/// candidate's drifted name mirrors its own new value.
#[test]
fn a_mutable_value_role_with_a_drifted_live_name_still_matches_on_native_id() {
    let stored = entry(
        Some("field-1"),
        "textfield",
        Some("Old Value"),
        Some("Old Value"),
        None,
    );
    let live = evidence(Some("New Value"), Some("New Value"), None, Some("field-1"));

    assert_eq!(candidate_outcome(&stored, &live), CandidateOutcome::Matched);
}

/// The same mutable-value role with a **stable** name (a labelled field
/// whose name does not mirror the value) keeps the corroboration tier: a
/// drifted name refutes even with a matching id, exactly as a stable-role
/// name would. The composition never special-cases mutable roles itself.
#[test]
fn a_mutable_value_role_with_a_stable_label_refutes_a_drifted_name() {
    let stored = entry(
        Some("field-2"),
        "textfield",
        Some("First Name"),
        Some("Alice"),
        None,
    );
    let drifted = evidence(
        Some("First Name Is Drifted"),
        Some("Alice"),
        None,
        Some("field-2"),
    );

    assert_eq!(
        candidate_outcome(&stored, &drifted),
        CandidateOutcome::Refuted
    );
}

/// A ref with no id and no stored text, against a blank live candidate,
/// is not-known rather than a confident non-match: core's
/// `empty_identity_match` reports `Unknown` (incomplete) instead of
/// inventing a `NoMatch`. The corroboration tier must survive the switch.
#[test]
fn a_blank_ref_and_a_blank_candidate_are_incomplete_not_refuted() {
    let stored = entry(None, "", None, None, None);
    let blank_live = evidence(None, None, None, None);

    assert_eq!(
        candidate_outcome(&stored, &blank_live),
        CandidateOutcome::Incomplete
    );
}

/// A ref whose stored name was blank cannot be refuted by a blank live
/// candidate when the id still matches - blank-cannot-refute, pinned on
/// the id-bearing side.
#[test]
fn a_blank_stored_name_does_not_refute_a_matching_id() {
    let stored = entry(Some("row-1"), "listitem", None, None, None);
    let live = evidence(None, None, None, Some("row-1"));

    assert_eq!(candidate_outcome(&stored, &live), CandidateOutcome::Matched);
}

/// A candidate whose native identifier cannot be read is incomplete: the
/// id tier cannot decide it, and an unreadable field is never a `NoMatch`.
#[test]
fn an_unreadable_native_id_is_incomplete() {
    let stored = entry(Some("btn-1"), "button", Some("Label"), None, None);
    let unreadable_id = LocatorEvidence {
        identifiers: IdentifierEvidence::unknown(),
        ..evidence(Some("Label"), None, None, None)
    };

    assert_eq!(
        candidate_outcome(&stored, &unreadable_id),
        CandidateOutcome::Incomplete
    );
}

#[test]
fn a_zero_candidate_resolution_is_stale_windows() {
    let stored = entry(Some("btn-1"), "button", Some("Label"), None, None);
    assert_eq!(stale_ref_error(&stored).code, ErrorCode::StaleRef);
}

/// The settled stale ref sits on two different retry axes at once, and a
/// regression on either is invisible from the error code alone. It must stay
/// query-level retryable, because that is what lets the caller's hydration
/// take its one fresh re-observation after the tree moved; and it must stay
/// out of the adapter's own loop, because replaying the same walk against the
/// same stored evidence cannot produce a different answer.
#[cfg(target_os = "windows")]
#[test]
fn a_settled_stale_ref_is_query_retryable_complete_and_not_adapter_loop_retryable() {
    let stored = entry(Some("btn-1"), "button", Some("Label"), None, None);
    let error = stale_ref_error(&stored);

    assert!(
        error.is_explicitly_retryable(),
        "hydration's fresh re-observation is gated on this stamp"
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("complete"))
            .and_then(serde_json::Value::as_bool),
        Some(true),
        "a completed search that found nothing is a complete answer"
    );
    assert!(
        !crate::tree::resolve::is_retryable_resolution_error(&error),
        "the adapter loop must not replay a settled non-match"
    );
}

/// The settled stale ref is what an agent reads, so its message is pinned
/// verbatim. Routing a whole sentence through core's `stale_ref` constructor,
/// whose parameter is a ref id it interpolates into `"{ref_id} not found in
/// current RefMap"`, produced a message that was both ungrammatical and wrong
/// about the cause - it reported a ref missing from the RefMap when the ref
/// had in fact resolved and lost against the live evidence. The suggestion and
/// the not-delivered disposition are pinned alongside it, because dropping
/// either is invisible from the message alone.
#[test]
fn the_settled_stale_ref_message_names_the_evidence_mismatch_not_a_missing_refmap_entry() {
    let stored = entry(Some("btn-1"), "button", Some("Label"), None, None);
    let error = stale_ref_error(&stored);

    assert_eq!(error.message, "Stored ref does not match any live element");
    assert!(
        !error.message.contains("RefMap"),
        "a resolved-but-refuted ref is not a missing RefMap entry: {}",
        error.message
    );
    assert_eq!(
        error.suggestion.as_deref(),
        Some("Run 'snapshot' to refresh, then retry with the updated ref.")
    );
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(
        error.is_explicitly_retryable() && error.permits_retry_by_default(),
        "the derived retryability must survive the construction change"
    );
}

/// The ambiguous verdict sits on the same two retry axes as its stale sibling
/// and used to stamp neither, so a regression on either was invisible. It is
/// complete because `classify_search` only reaches this arm with a conclusive
/// answer, and non-retryable because the same search over the same stored
/// evidence cannot separate the candidates on a second attempt - the stamp is
/// what keeps it out of core's resolution poll loop, which retries only an
/// explicitly retryable failure.
#[test]
fn an_ambiguous_target_is_complete_and_settled_rather_than_retried() {
    let stored = entry(Some("btn-1"), "button", Some("Label"), None, None);
    let error = ambiguous_target_error(&stored, 2);

    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(flag(&error, "complete"), Some(true));
    assert_eq!(flag(&error, "retryable"), Some(false));
    assert!(!error.is_explicitly_retryable());
    assert!(!error.permits_retry_by_default());
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("candidate_count"))
            .and_then(serde_json::Value::as_u64),
        Some(2),
        "the shape-only candidate count must survive the added stamps"
    );
}

fn flag(error: &agent_desktop_core::AdapterError, key: &str) -> Option<bool> {
    error
        .details
        .as_ref()
        .and_then(|details| details.get(key))
        .and_then(serde_json::Value::as_bool)
}

/// Two candidates carrying the same evidence, neither distinguished by
/// hash, must stay ambiguous - the caller's `AMBIGUOUS_TARGET`, not a
/// guess at either one.
#[test]
fn two_identical_evidence_candidates_stay_ambiguous() {
    let selection = select_by_bounds_hash(&[Some(1), Some(1)], Some(1));

    assert!(matches!(selection, Selection::Ambiguous));
}

/// Exactly one of several candidates carries the stored bounds hash: that
/// one resolves. The expected hash sits at index 1 on purpose, so a
/// first-match-wins regression (picking index 0 regardless of hash) would
/// fail this assertion rather than pass it by accident.
#[test]
fn the_sole_candidate_matching_the_stored_hash_resolves() {
    let selection = select_by_bounds_hash(&[Some(2), Some(1)], Some(1));

    assert!(matches!(selection, Selection::Resolved(1)));
}

/// A stored ref with no bounds hash cannot be disambiguated by hash at
/// all, so several candidates stay ambiguous rather than one being picked
/// by a `None == None` coincidence.
#[test]
fn no_stored_hash_cannot_disambiguate() {
    let selection = select_by_bounds_hash(&[None, None], None);

    assert!(matches!(selection, Selection::Ambiguous));
}
