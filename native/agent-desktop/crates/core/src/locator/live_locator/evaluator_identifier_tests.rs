use super::{
    IdentifierEvidence, LocatorMaterialization, LocatorResolveRequest, LocatorSelection,
    evaluate_locator_tree,
};
use crate::{
    locator::{IdentityPredicate, LocatorQuery},
    tree::search_text,
};

use super::test_support::{evidence, node, tree};

fn request() -> LocatorResolveRequest {
    LocatorResolveRequest {
        selection: LocatorSelection::Strict,
        deadline: crate::Deadline::from_duration(std::time::Duration::from_secs(5)).unwrap(),
        max_raw_depth: 50,
        surface: None,
        materialization: LocatorMaterialization::None,
    }
}

fn native_id_query(role: Option<&str>) -> LocatorQuery {
    LocatorQuery {
        identity: IdentityPredicate {
            role: role.map(search_text::normalize),
            native_id: Some("checkout".into()),
            ..IdentityPredicate::default()
        },
        ..LocatorQuery::default()
    }
}

#[test]
fn native_id_matches_either_identifier_source() {
    let mut candidate = evidence("button", Some("Checkout"));
    candidate.identifiers =
        IdentifierEvidence::new(["internal-id".into(), "checkout".into()], Some(0), true);
    let resolution = evaluate_locator_tree(
        tree(vec![node(0, candidate, vec![], &[])], vec![0], true),
        &native_id_query(None),
        &request(),
    )
    .unwrap();
    assert_eq!(resolution.meta.total_matches, 1);
    assert_eq!(resolution.stats.identifiers.fallback_matches, 1);
    assert_eq!(resolution.stats.identifiers.preferred_matches, 0);
}

#[test]
fn duplicate_identifier_value_counts_as_a_preferred_match() {
    let mut candidate = evidence("button", Some("Checkout"));
    candidate.identifiers = IdentifierEvidence::typed(
        [
            crate::ElementIdentifier {
                kind: crate::IdentifierKind::AxIdentifier,
                value: "checkout".into(),
            },
            crate::ElementIdentifier {
                kind: crate::IdentifierKind::AxDomIdentifier,
                value: "checkout".into(),
            },
        ],
        Some(1),
        true,
    );
    let resolution = evaluate_locator_tree(
        tree(vec![node(0, candidate, vec![], &[])], vec![0], true),
        &native_id_query(None),
        &request(),
    )
    .unwrap();
    assert_eq!(resolution.stats.identifiers.preferred_matches, 1);
    assert_eq!(resolution.stats.identifiers.fallback_matches, 0);
}

#[test]
fn identifier_stats_count_only_complete_query_matches() {
    let mut candidate = evidence("button", Some("Cancel"));
    candidate.identifiers = IdentifierEvidence::new(["checkout".into()], Some(0), true);
    let resolution = evaluate_locator_tree(
        tree(vec![node(0, candidate, vec![], &[])], vec![0], true),
        &native_id_query(Some("link")),
        &request(),
    )
    .unwrap();
    assert_eq!(resolution.meta.total_matches, 0);
    assert_eq!(resolution.stats.identifiers.preferred_matches, 0);
    assert_eq!(resolution.stats.identifiers.fallback_matches, 0);
}

#[test]
fn unknown_identifier_source_prevents_false_not_found() {
    let mut candidate = evidence("button", Some("Checkout"));
    candidate.identifiers = IdentifierEvidence::unknown();
    let resolution = evaluate_locator_tree(
        tree(vec![node(0, candidate, vec![], &[])], vec![0], true),
        &native_id_query(None),
        &request(),
    )
    .unwrap();
    assert!(!resolution.meta.complete);
    assert_eq!(resolution.meta.total_matches, 0);
}
