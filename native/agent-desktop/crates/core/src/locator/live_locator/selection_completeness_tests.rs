use super::{
    LocatorMaterialization, LocatorResolveRequest, LocatorSelection, evaluate_locator_tree,
};
use crate::LocatorQuery;

#[test]
fn first_match_is_authoritative_when_only_its_descendants_or_later_nodes_are_incomplete() {
    let mut tree = fixture_tree();
    tree.nodes[1].completeness.subtree_complete = false;
    tree.nodes[2].completeness.subtree_complete = false;
    tree.nodes[0].completeness.subtree_complete = false;
    tree.structurally_complete = false;

    let resolution = evaluate_locator_tree(tree, &button_query(), &first_request()).unwrap();

    assert!(!resolution.meta.complete);
    assert!(resolution.meta.selection_complete);
    assert_eq!(resolution.matches[0].document_order, 1);
}

#[test]
fn first_match_is_not_authoritative_when_an_earlier_subtree_is_incomplete() {
    let mut tree = fixture_tree();
    tree.nodes[1].evidence = super::test_support::evidence("group", Some("Earlier"));
    tree.nodes[1].completeness.subtree_complete = false;
    tree.nodes[2].evidence = super::test_support::evidence("button", Some("Selected"));
    tree.nodes[0].completeness.subtree_complete = false;
    tree.structurally_complete = false;

    let resolution = evaluate_locator_tree(tree, &button_query(), &first_request()).unwrap();

    assert!(!resolution.meta.complete);
    assert!(!resolution.meta.selection_complete);
    assert_eq!(resolution.matches[0].document_order, 2);
}

#[test]
fn first_match_is_authoritative_when_native_predecessors_are_complete() {
    let mut tree = single_retained_child_tree(0);
    tree.nodes[0].completeness.subtree_complete = false;
    tree.structurally_complete = false;

    let resolution = evaluate_locator_tree(tree, &button_query(), &first_request()).unwrap();

    assert!(!resolution.meta.complete);
    assert!(resolution.meta.selection_complete);
}

#[test]
fn first_match_is_not_authoritative_after_unobserved_native_predecessors() {
    let mut tree = single_retained_child_tree(2);
    tree.nodes[0].completeness.subtree_complete = false;
    tree.nodes[1].completeness.predecessors_complete = false;
    tree.structurally_complete = false;

    let resolution = evaluate_locator_tree(tree, &button_query(), &first_request()).unwrap();

    assert!(!resolution.meta.complete);
    assert!(!resolution.meta.selection_complete);
}

fn single_retained_child_tree(native_index: usize) -> super::ObservedTree {
    super::test_support::tree(
        vec![
            super::test_support::node(
                0,
                super::test_support::evidence("window", Some("Fixture")),
                vec![1],
                &[],
            ),
            super::test_support::node(
                1,
                super::test_support::evidence("button", Some("Selected")),
                Vec::new(),
                &[native_index],
            ),
        ],
        vec![0],
        true,
    )
}

fn fixture_tree() -> super::ObservedTree {
    super::test_support::tree(
        vec![
            super::test_support::node(
                0,
                super::test_support::evidence("window", Some("Fixture")),
                vec![1, 2],
                &[],
            ),
            super::test_support::node(
                1,
                super::test_support::evidence("button", Some("Selected")),
                Vec::new(),
                &[0],
            ),
            super::test_support::node(
                2,
                super::test_support::evidence("group", Some("Later")),
                Vec::new(),
                &[1],
            ),
        ],
        vec![0],
        true,
    )
}

fn button_query() -> LocatorQuery {
    LocatorQuery {
        identity: crate::IdentityPredicate {
            role: Some("button".into()),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn first_request() -> LocatorResolveRequest {
    LocatorResolveRequest {
        selection: LocatorSelection::First,
        deadline: crate::Deadline::after(500).unwrap(),
        max_raw_depth: 50,
        surface: None,
        materialization: LocatorMaterialization::None,
    }
}
