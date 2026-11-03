use super::test_support::window;
use super::{
    IdentifierEvidence, LocatorField, LocatorMaterialization, LocatorResolveRequest,
    LocatorSelection, ObservationRequest, ObservationRoot, ObservationSource, ObservedTree,
    resolve_query,
};
use crate::{
    AdapterError, ElementIdentifier, IdentifierKind, LocatorQuery, NativeHandle, Rect,
    adapter::{ActionOps, InputOps, ObservationOps, SystemOps},
};
use std::sync::atomic::{AtomicUsize, Ordering};

struct SingleAnchorAdapter {
    initial_id: Option<&'static str>,
    hydrated_id: Option<&'static str>,
    window_observations: AtomicUsize,
    strict_resolutions: AtomicUsize,
    hydration_observations: AtomicUsize,
    hydration_topology_complete: bool,
    hydrated_bounds: Rect,
    path_churn: bool,
}

impl ObservationOps for SingleAnchorAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        match root {
            ObservationRoot::Window(_) => {
                self.window_observations.fetch_add(1, Ordering::SeqCst);
                let evidence = request.descendant_evidence();
                assert!(evidence.identifiers);
                assert!(evidence.ref_evidence.bounds);
                assert!(!evidence.ref_evidence.actions);
                Ok(single_anchor_tree(self.initial_id))
            }
            ObservationRoot::Element { .. } => {
                self.hydration_observations.fetch_add(1, Ordering::SeqCst);
                Ok(single_hydration_tree(
                    root,
                    self.hydrated_id,
                    self.hydration_topology_complete,
                    self.hydrated_bounds,
                ))
            }
        }
    }

    fn resolve_locator_anchor(
        &self,
        entry: &crate::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.strict_resolutions.fetch_add(1, Ordering::SeqCst);
        assert_eq!(entry.scope.path.as_slice(), &[0]);
        assert_eq!(entry.geometry.bounds, Some(button_bounds()));
        if self.path_churn {
            return Err(AdapterError::new(
                crate::ErrorCode::StaleRef,
                "selected locator path changed",
            ));
        }
        Ok(NativeHandle::null())
    }
}

impl ActionOps for SingleAnchorAdapter {}
impl InputOps for SingleAnchorAdapter {}
impl SystemOps for SingleAnchorAdapter {}

#[test]
fn unnamed_selected_control_uses_original_geometry_as_its_hydration_anchor() {
    let adapter = adapter(None, None);

    let resolution = resolve_query(
        &adapter,
        &role_query("button"),
        ObservationRoot::Window(&window()),
        &selected_request(),
    )
    .expect("geometry must anchor an unnamed selected control");

    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.strict_resolutions.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 1);
    let entry = resolution.refmap.unwrap().get("@e1").unwrap().clone();
    assert_eq!(entry.identity.name, None);
    assert_eq!(entry.geometry.bounds, Some(button_bounds()));
}

#[test]
fn same_role_path_replacement_is_rejected_after_one_bounded_reobservation() {
    let adapter = adapter(Some("original-control"), Some("replacement-control"));

    let error = resolve_query(
        &adapter,
        &role_query("button"),
        ObservationRoot::Window(&window()),
        &selected_request(),
    )
    .err()
    .expect("a same-role replacement at the observed path must be rejected");

    assert_eq!(error.code(), "STALE_REF");
    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.strict_resolutions.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 2);
}

#[test]
fn geometry_churn_is_rejected_after_one_bounded_reobservation() {
    let adapter = SingleAnchorAdapter {
        hydrated_bounds: moved_bounds(),
        ..adapter(None, None)
    };

    let error = resolve_query(
        &adapter,
        &role_query("button"),
        ObservationRoot::Window(&window()),
        &selected_request(),
    )
    .err()
    .expect("geometry churn must invalidate a geometry-only anchor");

    assert_eq!(error.code(), "STALE_REF");
    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.strict_resolutions.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 2);
}

#[test]
fn exact_path_churn_never_falls_through_to_hydration() {
    let adapter = SingleAnchorAdapter {
        path_churn: true,
        ..adapter(None, None)
    };

    let error = resolve_query(
        &adapter,
        &role_query("button"),
        ObservationRoot::Window(&window()),
        &selected_request(),
    )
    .err()
    .expect("an exact-path miss must fail before selected hydration");

    assert_eq!(error.code(), "STALE_REF");
    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.strict_resolutions.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 0);
}

#[test]
fn complete_selected_root_evidence_does_not_require_descendant_topology() {
    let adapter = SingleAnchorAdapter {
        hydration_topology_complete: false,
        ..adapter(None, None)
    };

    let resolution = resolve_query(
        &adapter,
        &role_query("button"),
        ObservationRoot::Window(&window()),
        &selected_request(),
    )
    .expect("selected hydration consumes only its complete root evidence");

    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.strict_resolutions.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 1);
    assert_eq!(resolution.refmap.unwrap().len(), 1);
}

fn adapter(
    initial_id: Option<&'static str>,
    hydrated_id: Option<&'static str>,
) -> SingleAnchorAdapter {
    SingleAnchorAdapter {
        initial_id,
        hydrated_id,
        window_observations: AtomicUsize::new(0),
        strict_resolutions: AtomicUsize::new(0),
        hydration_observations: AtomicUsize::new(0),
        hydration_topology_complete: true,
        hydrated_bounds: button_bounds(),
        path_churn: false,
    }
}

fn role_query(role: &str) -> LocatorQuery {
    LocatorQuery {
        identity: crate::IdentityPredicate {
            role: Some(role.into()),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn selected_request() -> LocatorResolveRequest {
    LocatorResolveRequest {
        selection: LocatorSelection::First,
        deadline: crate::Deadline::after(5_000).unwrap(),
        max_raw_depth: 50,
        surface: None,
        materialization: LocatorMaterialization::SelectedMatches,
    }
}

fn single_anchor_tree(identifier: Option<&str>) -> ObservedTree {
    let mut anchor = super::test_support::evidence("button", identifier.map(|_| "Shared control"));
    anchor.identifiers = identifier_evidence(identifier);
    anchor.states = LocatorField::Unknown;
    anchor.ref_evidence.bounds = LocatorField::Known(button_bounds());
    anchor.ref_evidence.available_actions = LocatorField::Unknown;
    super::test_support::tree(
        vec![
            super::test_support::node(
                0,
                super::test_support::evidence("window", None),
                vec![1],
                &[],
            ),
            super::test_support::node(1, anchor, Vec::new(), &[0]),
        ],
        vec![0],
        true,
    )
}

fn single_hydration_tree(
    root: ObservationRoot<'_>,
    identifier: Option<&str>,
    topology_complete: bool,
    bounds: Rect,
) -> ObservedTree {
    let mut evidence =
        super::test_support::evidence("button", identifier.map(|_| "Shared control"));
    evidence.identifiers = identifier_evidence(identifier);
    evidence.ref_evidence.bounds = LocatorField::Known(bounds);
    evidence.ref_evidence.available_actions =
        LocatorField::Known(vec![crate::actions::capability::CLICK.into()]);
    let mut tree = super::test_support::tree(
        vec![super::test_support::node(0, evidence, Vec::new(), &[])],
        vec![0],
        true,
    );
    tree.source = ObservationSource::from_root(&root, crate::SnapshotSurface::Window);
    tree.structurally_complete = topology_complete;
    tree
}

fn identifier_evidence(identifier: Option<&str>) -> IdentifierEvidence {
    identifier.map_or_else(IdentifierEvidence::absent, |value| {
        IdentifierEvidence::typed(
            [ElementIdentifier {
                kind: IdentifierKind::AxIdentifier,
                value: value.into(),
            }],
            Some(0),
            true,
        )
    })
}

fn button_bounds() -> Rect {
    Rect {
        x: 10.0,
        y: 20.0,
        width: 100.0,
        height: 30.0,
    }
}

fn moved_bounds() -> Rect {
    Rect {
        x: 40.0,
        ..button_bounds()
    }
}
