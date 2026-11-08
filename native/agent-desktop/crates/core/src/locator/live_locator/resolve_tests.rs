use super::{
    LocatorMaterialization, LocatorResolveRequest, LocatorSelection, evaluate_locator_tree,
    require_unique,
};
use crate::{ErrorCode, locator::LocatorQuery};

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

#[test]
fn require_unique_returns_the_only_owned_match() {
    let resolution = evaluate_locator_tree(
        tree(
            vec![node(0, evidence("button", Some("Save")), vec![], &[])],
            vec![0],
            true,
        ),
        &LocatorQuery::default(),
        &request(),
    )
    .unwrap();
    let matched = require_unique(resolution).unwrap();
    assert_eq!(matched.document_order, 0);
}

#[test]
fn require_unique_maps_complete_zero_to_not_found() {
    let resolution = evaluate_locator_tree(
        tree(Vec::new(), Vec::new(), true),
        &LocatorQuery::default(),
        &request(),
    )
    .unwrap();
    let error = require_unique(resolution).err().unwrap();
    assert_eq!(error.code(), ErrorCode::ElementNotFound.as_str());
}

#[test]
fn require_unique_caps_ambiguous_candidate_summaries() {
    let nodes = (0..11)
        .map(|order| node(order, evidence("button", Some("Duplicate")), vec![], &[]))
        .collect();
    let roots = (0..11).collect();
    let resolution = evaluate_locator_tree(
        tree(nodes, roots, true),
        &LocatorQuery::default(),
        &request(),
    )
    .unwrap();
    let error = require_unique(resolution).err().unwrap();
    assert_eq!(error.code(), ErrorCode::AmbiguousTarget.as_str());
    let details = match error {
        crate::AppError::Adapter(error) => error.details.unwrap(),
        other => panic!("expected adapter error, got {other}"),
    };
    assert_eq!(details["candidate_count"], 11);
    assert_eq!(details["candidate_count_exact"], true);
    assert_eq!(details["candidates"].as_array().unwrap().len(), 10);
}

#[test]
fn require_unique_maps_incomplete_zero_or_one_to_timeout() {
    let resolution = evaluate_locator_tree(
        tree(
            vec![node(0, evidence("button", Some("Save")), vec![], &[])],
            vec![0],
            false,
        ),
        &LocatorQuery::default(),
        &request(),
    )
    .unwrap();
    let error = require_unique(resolution).err().unwrap();
    assert_eq!(error.code(), ErrorCode::Timeout.as_str());
    let details = match error {
        crate::AppError::Adapter(error) => error.details.unwrap(),
        other => panic!("expected adapter error, got {other}"),
    };
    assert_eq!(details["kind"], "locator_incomplete");
    assert_eq!(details["observed_matches"], 1);
}
