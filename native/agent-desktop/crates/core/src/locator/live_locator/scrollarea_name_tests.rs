use super::{
    LocatorField, LocatorMaterialization, LocatorResolveRequest, LocatorSelection,
    evaluate_locator_tree,
};
use crate::{IdentityPredicate, LocatorQuery};

#[test]
fn exact_named_scroll_area_is_unique_among_unnamed_scroll_containers() {
    let named = super::test_support::node(
        0,
        super::test_support::evidence("scrollarea", Some("scroll-area")),
        Vec::new(),
        &[],
    );
    let mut unnamed_evidence = super::test_support::evidence("scrollarea", None);
    unnamed_evidence.name = LocatorField::Absent;
    let unnamed = super::test_support::node(1, unnamed_evidence, Vec::new(), &[]);
    let tree = super::test_support::tree(vec![named, unnamed], vec![0, 1], true);
    let query = LocatorQuery {
        identity: IdentityPredicate {
            role: Some("scrollarea".into()),
            name: Some("scroll-area".into()),
            ..Default::default()
        },
        exact: true,
        ..Default::default()
    };
    let request = LocatorResolveRequest {
        selection: LocatorSelection::Strict,
        deadline: crate::Deadline::after(500).unwrap(),
        max_raw_depth: 50,
        surface: None,
        materialization: LocatorMaterialization::None,
    };

    let resolution = evaluate_locator_tree(tree, &query, &request).unwrap();

    assert!(resolution.meta.complete);
    assert!(resolution.meta.selection_complete);
    assert_eq!(resolution.meta.total_matches, 1);
}
