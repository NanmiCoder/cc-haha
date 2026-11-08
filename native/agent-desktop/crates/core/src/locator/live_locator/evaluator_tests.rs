use super::{
    LocatorCardinality, LocatorField, LocatorMaterialization, LocatorResolveRequest,
    LocatorSelection, classify_query_result, evaluate_locator_tree,
};
use crate::{
    locator::{ContainmentPredicate, IdentityPredicate, LocatorQuery},
    tree::search_text,
};

use super::test_support::{evidence, node, tree};

fn request(selection: LocatorSelection) -> LocatorResolveRequest {
    LocatorResolveRequest {
        selection,
        deadline: crate::Deadline::from_duration(std::time::Duration::from_secs(5)).unwrap(),
        max_raw_depth: 50,
        surface: None,
        materialization: LocatorMaterialization::None,
    }
}

fn named_query(name: &str, exact: bool) -> LocatorQuery {
    LocatorQuery {
        identity: IdentityPredicate {
            name: Some(search_text::normalize(name)),
            ..IdentityPredicate::default()
        },
        exact,
        ..LocatorQuery::default()
    }
}

fn names_tree() -> super::ObservedTree {
    tree(
        vec![
            node(0, evidence("button", Some("Save draft")), vec![], &[]),
            node(1, evidence("button", Some("save")), vec![], &[]),
            node(2, evidence("button", Some("SAVE")), vec![], &[]),
        ],
        vec![0, 1, 2],
        true,
    )
}

#[test]
fn exact_and_substring_matching_use_normalized_document_order() {
    let substring = evaluate_locator_tree(
        names_tree(),
        &named_query("SAVE", false),
        &request(LocatorSelection::All { limit: None }),
    )
    .unwrap();
    assert_eq!(substring.meta.total_matches, 3);
    assert_eq!(substring.matches[0].data.name, "Save draft");
    assert_eq!(substring.matches[1].data.name, "save");
    assert_eq!(substring.matches[2].data.name, "SAVE");

    let exact = evaluate_locator_tree(
        names_tree(),
        &named_query("SAVE", true),
        &request(LocatorSelection::All { limit: None }),
    )
    .unwrap();
    assert_eq!(exact.meta.total_matches, 2);
    assert_eq!(exact.matches[0].document_order, 1);
    assert_eq!(exact.matches[1].document_order, 2);
}

fn deep_tree(structurally_complete: bool) -> super::ObservedTree {
    let mut nodes = Vec::new();
    for depth in 0..30 {
        let name = (depth == 0).then_some("root");
        let mut parent = node(
            depth,
            evidence("group", name),
            vec![depth + 1],
            &vec![0; depth as usize],
        );
        if depth == 0 {
            parent.completeness.subtree_complete = structurally_complete;
        }
        nodes.push(parent);
    }
    nodes.push(node(
        30,
        evidence("button", Some("Deep Needle")),
        vec![],
        &vec![0; 30],
    ));
    tree(nodes, vec![0], structurally_complete)
}

#[test]
fn deep_has_text_and_has_walk_all_descendants() {
    let has_text = LocatorQuery {
        identity: IdentityPredicate {
            name: Some("root".into()),
            ..IdentityPredicate::default()
        },
        has_text: Some("needle".into()),
        ..LocatorQuery::default()
    };
    let text_resolution = evaluate_locator_tree(
        deep_tree(true),
        &has_text,
        &request(LocatorSelection::Strict),
    )
    .unwrap();
    assert_eq!(
        classify_query_result(&text_resolution),
        LocatorCardinality::One
    );
    assert_eq!(text_resolution.stats.evaluation.memo_cells_evaluated, 93);

    let has_button = LocatorQuery {
        identity: IdentityPredicate {
            name: Some("root".into()),
            ..IdentityPredicate::default()
        },
        containment: ContainmentPredicate {
            has: Some(Box::new(LocatorQuery {
                identity: IdentityPredicate {
                    role: Some("button".into()),
                    ..IdentityPredicate::default()
                },
                ..LocatorQuery::default()
            })),
            has_not: None,
        },
        ..LocatorQuery::default()
    };
    let has_resolution = evaluate_locator_tree(
        deep_tree(true),
        &has_button,
        &request(LocatorSelection::Strict),
    )
    .unwrap();
    assert_eq!(has_resolution.meta.total_matches, 1);
}

#[test]
fn incomplete_deep_has_not_is_unknown() {
    let query = LocatorQuery {
        identity: IdentityPredicate {
            name: Some("root".into()),
            ..IdentityPredicate::default()
        },
        containment: ContainmentPredicate {
            has: None,
            has_not: Some(Box::new(named_query("missing", false))),
        },
        ..LocatorQuery::default()
    };
    let resolution =
        evaluate_locator_tree(deep_tree(false), &query, &request(LocatorSelection::Strict))
            .unwrap();
    assert_eq!(resolution.meta.total_matches, 0);
    assert!(!resolution.meta.complete);
    assert_eq!(
        classify_query_result(&resolution),
        LocatorCardinality::Incomplete { observed: 0 }
    );
}

#[test]
fn known_role_mismatch_dominates_unknown_name() {
    let mut unknown = evidence("button", None);
    unknown.name = LocatorField::Unknown;
    let query = LocatorQuery {
        identity: IdentityPredicate {
            role: Some("link".into()),
            name: Some("save".into()),
            ..IdentityPredicate::default()
        },
        ..LocatorQuery::default()
    };
    let resolution = evaluate_locator_tree(
        tree(vec![node(0, unknown, vec![], &[])], vec![0], true),
        &query,
        &request(LocatorSelection::Strict),
    )
    .unwrap();
    assert!(resolution.meta.complete);
    assert_eq!(resolution.meta.total_matches, 0);
}

#[test]
fn candidate_role_with_unknown_name_remains_incomplete() {
    let mut unknown = evidence("button", None);
    unknown.name = LocatorField::Unknown;
    let query = LocatorQuery {
        identity: IdentityPredicate {
            role: Some("button".into()),
            name: Some("save".into()),
            ..IdentityPredicate::default()
        },
        exact: true,
        ..LocatorQuery::default()
    };

    let resolution = evaluate_locator_tree(
        tree(vec![node(0, unknown, vec![], &[])], vec![0], true),
        &query,
        &request(LocatorSelection::Strict),
    )
    .unwrap();

    assert!(!resolution.meta.complete);
    assert_eq!(
        classify_query_result(&resolution),
        LocatorCardinality::Incomplete { observed: 0 }
    );
}

#[test]
fn later_known_fields_decide_unknown_predicates() {
    let mut evidence = evidence("button", Some("Save"));
    evidence.role = LocatorField::Unknown;
    evidence.description = LocatorField::Unknown;
    let mut stats = Default::default();
    let query = LocatorQuery {
        identity: IdentityPredicate {
            role: Some("button".into()),
            name: Some("missing".into()),
            ..IdentityPredicate::default()
        },
        ..LocatorQuery::default()
    };
    assert_eq!(
        super::predicate::self_verdict(&query, &evidence, &mut stats),
        super::match_verdict::MatchVerdict::NoMatch
    );
    evidence.name = LocatorField::Unknown;
    evidence.value = LocatorField::Known("SAVE".into());
    assert_eq!(
        super::predicate::self_text_verdict(Some("save"), &evidence, false),
        super::match_verdict::MatchVerdict::Match
    );
}

#[test]
fn ordinal_selection_uses_document_order() {
    for (selection, expected) in [
        (LocatorSelection::First, 0),
        (LocatorSelection::Nth(1), 1),
        (LocatorSelection::Last, 2),
    ] {
        let resolution =
            evaluate_locator_tree(names_tree(), &LocatorQuery::default(), &request(selection))
                .unwrap();
        assert_eq!(resolution.matches[0].document_order, expected);
    }
}

#[test]
fn strict_classification_preserves_zero_one_many_and_incomplete() {
    let zero = evaluate_locator_tree(
        names_tree(),
        &named_query("missing", false),
        &request(LocatorSelection::Strict),
    )
    .unwrap();
    assert_eq!(classify_query_result(&zero), LocatorCardinality::Zero);

    let one = evaluate_locator_tree(
        tree(
            vec![node(0, evidence("button", Some("one")), vec![], &[])],
            vec![0],
            true,
        ),
        &LocatorQuery::default(),
        &request(LocatorSelection::Strict),
    )
    .unwrap();
    assert_eq!(classify_query_result(&one), LocatorCardinality::One);

    let many = evaluate_locator_tree(
        names_tree(),
        &LocatorQuery::default(),
        &request(LocatorSelection::Strict),
    )
    .unwrap();
    assert_eq!(
        classify_query_result(&many),
        LocatorCardinality::Many {
            observed: 3,
            exact: true
        }
    );

    let mut incomplete_tree = names_tree();
    incomplete_tree.structurally_complete = false;
    let incomplete_many = evaluate_locator_tree(
        incomplete_tree,
        &LocatorQuery::default(),
        &request(LocatorSelection::Strict),
    )
    .unwrap();
    assert_eq!(
        classify_query_result(&incomplete_many),
        LocatorCardinality::Many {
            observed: 3,
            exact: false
        }
    );
}

#[test]
fn dense_evaluator_has_a_linear_memo_cell_bound_at_twenty_thousand_nodes() {
    let nodes = (0..20_000)
        .map(|order| node(order, evidence("button", Some("Match")), vec![], &[]))
        .collect();
    let roots = (0..20_000).collect();
    let query = LocatorQuery {
        containment: ContainmentPredicate {
            has: None,
            has_not: Some(Box::new(LocatorQuery::default())),
        },
        ..LocatorQuery::default()
    };
    let resolution = evaluate_locator_tree(
        tree(nodes, roots, true),
        &query,
        &request(LocatorSelection::Count),
    )
    .unwrap();
    assert_eq!(resolution.meta.total_matches, 20_000);
    assert_eq!(resolution.stats.evaluation.query_clause_count, 2);
    assert_eq!(resolution.stats.evaluation.memo_cells_evaluated, 80_000);
}
