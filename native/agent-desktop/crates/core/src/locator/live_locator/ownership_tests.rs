use super::{
    LocatorMaterialization, LocatorResolveRequest, LocatorSelection, evaluate_locator_tree,
};
use crate::locator::LocatorQuery;

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

#[test]
fn count_returns_no_target_ownership() {
    let resolution = evaluate_locator_tree(
        tree(
            vec![node(0, evidence("button", Some("match")), vec![], &[])],
            vec![0],
            true,
        ),
        &LocatorQuery::default(),
        &request(LocatorSelection::Count),
    )
    .unwrap();

    assert!(resolution.matches.is_empty());
}
