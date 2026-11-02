use super::tests::entry;
use super::*;
use crate::tree::AXElement;
use crate::tree::resolve::resolve_classify::{
    BoundsMatchOutcome, classify_bounds_matches, classify_candidates,
};
use crate::tree::resolve::resolve_search::{match_native_or_text_identity, should_stop_collecting};

#[test]
fn identifier_kind_mismatch_is_not_an_exact_match() {
    use agent_desktop_core::{
        ElementIdentifier, IdentifierEvidence, IdentifierKind, LocatorEvidence, LocatorField,
        LocatorRefEvidence,
    };

    let mut stored = entry(Some(42), Some("w-42"), None, None);
    stored.identity.native_id = Some(ElementIdentifier {
        kind: IdentifierKind::AxIdentifier,
        value: "stable-id".into(),
    });
    let live = LocatorEvidence {
        role: LocatorField::Known(stored.identity.role.clone()),
        name: LocatorField::Known("Investors".into()),
        description: LocatorField::Absent,
        value: LocatorField::Absent,
        identifiers: IdentifierEvidence::typed(
            [ElementIdentifier {
                kind: IdentifierKind::AxDomIdentifier,
                value: "stable-id".into(),
            }],
            Some(0),
            true,
        ),
        states: LocatorField::Absent,
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Absent,
            available_actions: LocatorField::Absent,
            descriptors: Default::default(),
        },
    };

    assert_eq!(
        match_native_or_text_identity(&stored, &live),
        agent_desktop_core::IdentityMatch::NoMatch
    );
}

#[test]
fn duplicate_identity_candidates_are_stale_when_bounds_drift() {
    let error = classify_candidates(
        vec![
            AXElement(std::ptr::null_mut()),
            AXElement(std::ptr::null_mut()),
        ],
        &entry(Some(42), Some("w-42"), None, None),
        true,
        Instant::now() + Duration::from_secs(1),
    )
    .err()
    .expect("bounds mismatch against every candidate must be stale, not ambiguous");

    assert_eq!(error.code, ErrorCode::StaleRef);
    let details = error.details.unwrap();
    assert_eq!(details["kind"], "bounds_mismatch");
    assert_eq!(details["candidate_count"], 2);
}

#[test]
fn missing_bounds_hash_always_falls_through_to_ambiguous() {
    assert_eq!(
        classify_bounds_matches(0, false),
        BoundsMatchOutcome::Ambiguous
    );
    assert_eq!(
        classify_bounds_matches(2, false),
        BoundsMatchOutcome::Ambiguous
    );
}

#[test]
fn zero_bounds_matches_is_stale_not_ambiguous() {
    assert_eq!(classify_bounds_matches(0, true), BoundsMatchOutcome::Stale);
}

#[test]
fn one_bounds_match_resolves_uniquely() {
    assert_eq!(
        classify_bounds_matches(1, true),
        BoundsMatchOutcome::Resolved
    );
}

#[test]
fn two_or_more_bounds_matches_remain_ambiguous() {
    assert_eq!(
        classify_bounds_matches(2, true),
        BoundsMatchOutcome::Ambiguous
    );
    assert_eq!(
        classify_bounds_matches(38, true),
        BoundsMatchOutcome::Ambiguous
    );
}

#[test]
fn unscoped_candidate_requires_matching_bounds() {
    let error = classify_candidates(
        vec![AXElement(std::ptr::null_mut())],
        &entry(Some(42), Some("w-42"), None, None),
        false,
        Instant::now() + Duration::from_secs(1),
    )
    .err()
    .expect("unscoped candidate without matching bounds must fail");

    assert_eq!(error.code, ErrorCode::ElementNotFound);
}

#[test]
fn bounds_search_keeps_collecting_for_disambiguation() {
    assert!(!should_stop_collecting(
        2,
        &entry(Some(42), None, None, None)
    ));
    assert!(should_stop_collecting(2, &entry(None, None, None, None)));
}

#[test]
fn ax_read_errors_distinguish_absent_unknown_and_permission_denied() {
    use accessibility_sys::{
        kAXErrorAPIDisabled, kAXErrorAttributeUnsupported, kAXErrorCannotComplete,
        kAXErrorInvalidUIElement,
    };

    assert!(
        !crate::tree::resolve::resolve_ax_read::classify_ax_read(
            kAXErrorAttributeUnsupported,
            "AXIdentifier"
        )
        .unwrap()
    );
    for error in [kAXErrorCannotComplete, kAXErrorInvalidUIElement] {
        let classified =
            crate::tree::resolve::resolve_ax_read::classify_ax_read(error, "AXIdentifier")
                .unwrap_err();
        assert_eq!(classified.code, ErrorCode::AppUnresponsive);
        assert_eq!(classified.details.unwrap()["complete"], false);
    }
    let denied = crate::tree::resolve::resolve_ax_read::classify_ax_read(
        kAXErrorAPIDisabled,
        "AXIdentifier",
    )
    .unwrap_err();
    assert_eq!(denied.code, ErrorCode::PermDenied);
}

#[test]
fn identity_unknown_then_success_retries_within_the_budget() {
    let entry = entry(Some(42), Some("w-42"), None, None);
    let attempts = std::cell::Cell::new(0);
    let deadline = Instant::now() + Duration::from_secs(5);

    let result = retry_incomplete_until(deadline, || {
        attempts.set(attempts.get() + 1);
        if attempts.get() == 1 {
            Err(agent_desktop_core::refs::resolve_errors::identity_unknown_error(&entry))
        } else {
            Ok(7_u8)
        }
    });

    assert_eq!(result.unwrap(), 7);
    assert_eq!(attempts.get(), 2);
}
