use super::{
    IdentifierEvidence, LocatorField, LocatorMaterialization, LocatorResolveRequest,
    LocatorSelection, ObservationSource, evaluate_locator_tree,
};
use crate::{
    actions::capability,
    adapter::SnapshotSurface,
    locator::IdentityPredicate,
    locator::LocatorQuery,
    refs::{RefEntry, RefPath},
};

use super::test_support::{evidence, node, tree};

fn request() -> LocatorResolveRequest {
    LocatorResolveRequest {
        selection: LocatorSelection::Strict,
        deadline: crate::Deadline::from_duration(std::time::Duration::from_secs(5)).unwrap(),
        max_raw_depth: 50,
        surface: None,
        materialization: LocatorMaterialization::FullRefMap,
    }
}

#[test]
fn selected_materialization_persists_only_returned_matches() {
    let buttons = (0..512)
        .map(|index| {
            node(
                index + 1,
                evidence("button", Some(&format!("Button {index}"))),
                Vec::new(),
                &[index as usize],
            )
        })
        .collect::<Vec<_>>();
    let children = (0..512).map(|index| index + 1).collect::<Vec<_>>();
    let mut nodes = vec![node(0, evidence("window", Some("Fixture")), children, &[])];
    nodes.extend(buttons);
    let query = LocatorQuery {
        identity: IdentityPredicate {
            role: Some("button".into()),
            ..IdentityPredicate::default()
        },
        ..LocatorQuery::default()
    };
    let resolution = evaluate_locator_tree(
        tree(nodes, vec![0], true),
        &query,
        &LocatorResolveRequest {
            selection: LocatorSelection::First,
            deadline: crate::Deadline::from_duration(std::time::Duration::from_secs(5)).unwrap(),
            max_raw_depth: 50,
            surface: None,
            materialization: LocatorMaterialization::SelectedMatches,
        },
    )
    .unwrap();

    assert_eq!(resolution.refmap.as_ref().unwrap().len(), 1);
    assert_eq!(resolution.matches[0].data.ref_id.as_deref(), Some("@e1"));
    assert_eq!(resolution.matches[0].data.name, "Button 0");
}

#[test]
fn full_refmap_uses_same_arena_evidence_and_document_order() {
    let mut button = evidence("button", Some("Checkout"));
    button.identifiers = IdentifierEvidence::typed(
        ["internal-id", "checkout"].map(|value| crate::ElementIdentifier {
            kind: crate::IdentifierKind::AxIdentifier,
            value: value.into(),
        }),
        Some(0),
        true,
    );
    let mut disclosure = evidence("disclosure", Some("Details"));
    disclosure.ref_evidence.available_actions =
        LocatorField::Known(vec![capability::EXPAND.into()]);
    let mut root = evidence("window", Some("Fixture"));
    root.ref_evidence.available_actions = LocatorField::Known(vec![capability::SET_FOCUS.into()]);
    let query = LocatorQuery {
        identity: IdentityPredicate {
            native_id: Some("checkout".into()),
            ..IdentityPredicate::default()
        },
        ..LocatorQuery::default()
    };

    let resolution = evaluate_locator_tree(
        tree(
            vec![
                node(0, root, vec![1, 2], &[]),
                node(1, button, vec![], &[0]),
                node(2, disclosure, vec![], &[1]),
            ],
            vec![0],
            true,
        ),
        &query,
        &request(),
    )
    .unwrap();

    let refmap = resolution.refmap.as_ref().unwrap();
    assert_eq!(refmap.len(), 2);
    let checkout = refmap.get("@e1").unwrap();
    assert_eq!(
        checkout
            .identity
            .native_id
            .as_ref()
            .map(|identifier| identifier.value.as_str()),
        Some("checkout")
    );
    assert_eq!(checkout.scope.path.as_slice(), &[0]);
    assert!(checkout.capabilities.available_actions.is_empty());
    assert_eq!(resolution.matches[0].data.ref_id.as_deref(), Some("@e1"));
    assert_eq!(resolution.matches[0].data.path, ["window:Fixture"]);
}

#[test]
fn web_node_with_only_ubiquitous_affordances_matches_without_a_ref() {
    let mut row = evidence("group", Some("Task row"));
    row.ref_evidence.available_actions = LocatorField::Known(vec![
        capability::RIGHT_CLICK.into(),
        capability::SCROLL_TO.into(),
    ]);
    let query = LocatorQuery {
        identity: IdentityPredicate {
            name: Some("Task row".into()),
            ..IdentityPredicate::default()
        },
        ..LocatorQuery::default()
    };

    let resolution = evaluate_locator_tree(
        tree(
            vec![
                node(0, evidence("window", Some("Fixture")), vec![1], &[]),
                node(1, row, vec![], &[0]),
            ],
            vec![0],
            true,
        ),
        &query,
        &request(),
    )
    .unwrap();

    assert!(resolution.meta.complete);
    assert_eq!(resolution.refmap.as_ref().map_or(0, |map| map.len()), 0);
    assert!(resolution.matches[0].data.ref_id.is_none());
    assert!(!resolution.matches[0].data.interactive);
}

#[test]
fn selected_identifier_prefers_typed_preferred_duplicate() {
    let mut button = evidence("button", Some("Checkout"));
    button.identifiers = IdentifierEvidence::typed(
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
    let query = LocatorQuery {
        identity: IdentityPredicate {
            native_id: Some("checkout".into()),
            ..IdentityPredicate::default()
        },
        ..LocatorQuery::default()
    };

    let resolution = evaluate_locator_tree(
        tree(vec![node(0, button, vec![], &[])], vec![0], true),
        &query,
        &request(),
    )
    .unwrap();

    assert_eq!(
        resolution
            .refmap
            .unwrap()
            .get("@e1")
            .unwrap()
            .identity
            .native_id,
        Some(crate::ElementIdentifier {
            kind: crate::IdentifierKind::AxDomIdentifier,
            value: "checkout".into(),
        })
    );
}

#[test]
fn unknown_noninteractive_actions_make_full_refmap_incomplete() {
    let mut group = evidence("group", Some("Container"));
    group.ref_evidence.available_actions = LocatorField::Unknown;
    let resolution = evaluate_locator_tree(
        tree(vec![node(0, group, vec![], &[])], vec![0], true),
        &LocatorQuery::default(),
        &request(),
    )
    .unwrap();
    assert!(!resolution.meta.complete);
    assert!(resolution.refmap.unwrap().is_empty());
}

#[test]
fn window_source_materialization_preserves_geometry_generation_evidence() {
    let bounds = crate::Rect {
        x: 10.0,
        y: 20.0,
        width: 800.0,
        height: 600.0,
    };
    let mut observed = tree(
        vec![node(0, evidence("button", Some("Save")), vec![], &[])],
        vec![0],
        true,
    );
    let ObservationSource::Window { window, .. } = &mut observed.source else {
        panic!("fixture must use a window source");
    };
    window.bounds = Some(bounds);

    let resolution = evaluate_locator_tree(observed, &LocatorQuery::default(), &request()).unwrap();
    let saved = resolution.refmap.unwrap().get("@e1").unwrap().clone();

    assert_eq!(saved.source.source_window_bounds_hash, bounds.bounds_hash());
}

#[test]
fn ref_entry_prefers_the_window_rectangle_and_tags_its_space() {
    let window_bounds = crate::Rect {
        x: 4.0,
        y: 8.0,
        width: 120.0,
        height: 24.0,
    };
    let screen_bounds = crate::Rect {
        x: 304.0,
        y: 208.0,
        width: 120.0,
        height: 24.0,
    };
    let mut button = evidence("button", Some("Save"));
    button.ref_evidence.window_bounds = LocatorField::Known(window_bounds);
    button.ref_evidence.bounds = LocatorField::Known(screen_bounds);
    let observed = tree(vec![node(0, button, vec![], &[])], vec![0], true);

    let entry = super::materialize::ref_entry(
        &observed.nodes[0],
        &observed.source,
        &LocatorQuery::default(),
    );

    assert_eq!(entry.geometry.bounds, Some(window_bounds));
    assert_eq!(entry.geometry.bounds_hash, window_bounds.bounds_hash());
    assert_eq!(
        entry.geometry.bounds_space,
        Some(crate::BoundsSpace::Window)
    );
}

#[test]
fn scoped_refmap_extends_source_path_without_index_correlation() {
    let root = evidence("group", Some("Scope"));
    let button = evidence("button", Some("Save"));
    let mut scoped = tree(
        vec![node(0, root, vec![1], &[]), node(1, button, vec![], &[0])],
        vec![0],
        true,
    );
    scoped.source = ObservationSource::Element {
        entry: Box::new(source_entry()),
        root_ref: Some("@e7".into()),
    };
    let query = LocatorQuery {
        identity: IdentityPredicate {
            role: Some("button".into()),
            ..IdentityPredicate::default()
        },
        ..LocatorQuery::default()
    };
    let resolution = evaluate_locator_tree(scoped, &query, &request()).unwrap();
    let refmap = resolution.refmap.unwrap();
    let entry = refmap.get("@e1").unwrap();
    assert_eq!(entry.scope.path.as_slice(), &[3, 0]);
    assert_eq!(entry.scope.root_ref.as_deref(), Some("@e7"));
    assert!(entry.scope.path_is_absolute);
    assert_eq!(entry.source.source_surface, SnapshotSurface::Menu);
}

fn source_entry() -> RefEntry {
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(42),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "group".into(),
            name: Some("Scope".into()),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash: None,
        },
        capabilities: crate::RefCapabilities {
            states: Vec::new(),
            available_actions: Vec::new(),
        },
        source: crate::RefSource {
            source_app: Some("FixtureApp".into()),
            source_window_id: Some("w-1".into()),
            source_window_title: Some("Fixture".into()),
            source_window_bounds_hash: None,
            source_surface: SnapshotSurface::Menu,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: RefPath::from_slice(&[3]),
        },
    }
}
