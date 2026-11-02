use super::test_support::window;
use super::{
    IdentifierEvidence, LocatorField, LocatorMaterialization, LocatorResolveRequest,
    LocatorSelection, ObservationRequest, ObservationRoot, ObservationSource, ObservedTree,
    resolve_query,
};
use crate::{
    AdapterError, AppError, ContainmentPredicate, LocatorQuery, NativeHandle, Rect,
    adapter::{ActionOps, InputOps, ObservationOps, SystemOps},
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Copy)]
enum Mode {
    TextWitnessRemoved,
    WitnessRemoved,
    ForbiddenAdded,
    NegativeIncomplete,
    PositiveIncompleteSuffix,
}

struct SubtreeHydrationAdapter {
    mode: Mode,
    window_observations: AtomicUsize,
    anchor_resolutions: AtomicUsize,
    selected_observations: AtomicUsize,
}

impl ObservationOps for SubtreeHydrationAdapter {
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
                assert!(!evidence.states);
                assert!(!evidence.ref_evidence.actions);
                Ok(initial_tree(self.mode))
            }
            ObservationRoot::Element { .. } => {
                self.selected_observations.fetch_add(1, Ordering::SeqCst);
                assert_eq!(request.max_logical_depth, 10);
                assert_eq!(
                    request.evidence_for_raw_depth(0),
                    super::EvidenceRequirements::snapshot()
                );
                assert!(!request.evidence_for_raw_depth(1).ref_evidence.actions);
                assert!(!request.evidence_for_raw_depth(1).states);
                Ok(selected_tree(root, self.mode))
            }
        }
    }

    fn resolve_locator_anchor(
        &self,
        entry: &crate::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.anchor_resolutions.fetch_add(1, Ordering::SeqCst);
        assert_eq!(entry.geometry.bounds, Some(root_bounds()));
        Ok(NativeHandle::null())
    }
}

impl ActionOps for SubtreeHydrationAdapter {}
impl InputOps for SubtreeHydrationAdapter {}
impl SystemOps for SubtreeHydrationAdapter {}

#[test]
fn has_text_witness_removed_between_phases_is_rejected() {
    assert_stale(Mode::TextWitnessRemoved, query(Mode::TextWitnessRemoved));
}

#[test]
fn containment_witness_removed_between_phases_is_rejected() {
    assert_stale(Mode::WitnessRemoved, query(Mode::WitnessRemoved));
}

#[test]
fn forbidden_descendant_added_between_phases_is_rejected() {
    assert_stale(Mode::ForbiddenAdded, query(Mode::ForbiddenAdded));
}

#[test]
fn incomplete_negative_absence_proof_fails_closed() {
    let adapter = adapter(Mode::NegativeIncomplete);
    let error = resolve_query(
        &adapter,
        &query(Mode::NegativeIncomplete),
        ObservationRoot::Window(&window()),
        &request(),
    )
    .err()
    .expect("incomplete has-not evidence must never prove absence");
    let error = adapter_error(error);

    assert_eq!(error.code.as_str(), "TIMEOUT");
    assert_eq!(
        error.details.as_ref().unwrap()["kind"],
        "locator_selected_query_incomplete"
    );
    assert_attempts(&adapter, 2);
}

#[test]
fn positive_witness_survives_an_irrelevant_incomplete_suffix() {
    let adapter = adapter(Mode::PositiveIncompleteSuffix);
    let resolution = resolve_query(
        &adapter,
        &query(Mode::PositiveIncompleteSuffix),
        ObservationRoot::Window(&window()),
        &request(),
    )
    .expect("a witnessed positive predicate does not need an irrelevant suffix");

    assert_attempts(&adapter, 1);
    assert!(resolution.meta.selection_complete);
    assert_eq!(resolution.matches.len(), 1);
}

fn assert_stale(mode: Mode, query: LocatorQuery) {
    let adapter = adapter(mode);
    let error = resolve_query(
        &adapter,
        &query,
        ObservationRoot::Window(&window()),
        &request(),
    )
    .err()
    .expect("descendant churn must invalidate the selected match");
    let error = adapter_error(error);

    assert_eq!(error.code.as_str(), "STALE_REF");
    assert_attempts(&adapter, 2);
}

fn assert_attempts(adapter: &SubtreeHydrationAdapter, expected: usize) {
    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), expected);
    assert_eq!(adapter.anchor_resolutions.load(Ordering::SeqCst), expected);
    assert_eq!(
        adapter.selected_observations.load(Ordering::SeqCst),
        expected
    );
}

fn adapter(mode: Mode) -> SubtreeHydrationAdapter {
    SubtreeHydrationAdapter {
        mode,
        window_observations: AtomicUsize::new(0),
        anchor_resolutions: AtomicUsize::new(0),
        selected_observations: AtomicUsize::new(0),
    }
}

fn initial_tree(mode: Mode) -> ObservedTree {
    let child = match mode {
        Mode::TextWitnessRemoved => text_evidence("needle"),
        Mode::WitnessRemoved | Mode::PositiveIncompleteSuffix => role_evidence("button"),
        Mode::ForbiddenAdded | Mode::NegativeIncomplete => role_evidence("link"),
    };
    super::test_support::tree(
        vec![
            super::test_support::node(0, phase_one_root(mode), vec![1], &[]),
            super::test_support::node(1, child, Vec::new(), &[0]),
        ],
        vec![0],
        true,
    )
}

fn selected_tree(root: ObservationRoot<'_>, mode: Mode) -> ObservedTree {
    let children = match mode {
        Mode::TextWitnessRemoved => vec![text_evidence("other")],
        Mode::WitnessRemoved => vec![role_evidence("link")],
        Mode::ForbiddenAdded => vec![role_evidence("button")],
        Mode::NegativeIncomplete => vec![role_evidence("link")],
        Mode::PositiveIncompleteSuffix => {
            vec![role_evidence("button"), role_evidence("group")]
        }
    };
    let child_indices = (1..=children.len())
        .map(|index| u32::try_from(index).unwrap())
        .collect();
    let mut nodes = vec![super::test_support::node(
        0,
        hydrated_root(),
        child_indices,
        &[],
    )];
    for (index, evidence) in children.into_iter().enumerate() {
        nodes.push(super::test_support::node(
            u32::try_from(index + 1).unwrap(),
            evidence,
            Vec::new(),
            &[index],
        ));
    }
    let incomplete = matches!(
        mode,
        Mode::NegativeIncomplete | Mode::PositiveIncompleteSuffix
    );
    if incomplete {
        nodes[0].completeness.subtree_complete = false;
        let last = nodes.len() - 1;
        nodes[last].completeness.subtree_complete = false;
    }
    let mut tree = super::test_support::tree(nodes, vec![0], !incomplete);
    tree.source = ObservationSource::from_root(&root, crate::SnapshotSurface::Window);
    tree
}

fn phase_one_root(mode: Mode) -> super::LocatorEvidence {
    let mut evidence = role_evidence("group");
    if matches!(mode, Mode::TextWitnessRemoved) {
        evidence.name = LocatorField::Absent;
        evidence.description = LocatorField::Absent;
        evidence.value = LocatorField::Absent;
    }
    evidence.identifiers = IdentifierEvidence::absent();
    evidence.ref_evidence.bounds = LocatorField::Known(root_bounds());
    evidence
}

fn hydrated_root() -> super::LocatorEvidence {
    let mut evidence = super::test_support::evidence("group", None);
    evidence.ref_evidence.bounds = LocatorField::Known(root_bounds());
    evidence
}

fn role_evidence(role: &str) -> super::LocatorEvidence {
    let mut evidence = super::test_support::evidence(role, None);
    evidence.name = LocatorField::Unknown;
    evidence.description = LocatorField::Unknown;
    evidence.value = LocatorField::Unknown;
    evidence.identifiers = IdentifierEvidence::unknown();
    evidence.states = LocatorField::Unknown;
    evidence.ref_evidence.bounds = LocatorField::Unknown;
    evidence.ref_evidence.available_actions = LocatorField::Unknown;
    evidence
}

fn text_evidence(text: &str) -> super::LocatorEvidence {
    let mut evidence = role_evidence("statictext");
    evidence.name = LocatorField::Known(text.into());
    evidence.description = LocatorField::Absent;
    evidence.value = LocatorField::Absent;
    evidence
}

fn query(mode: Mode) -> LocatorQuery {
    let mut query = LocatorQuery {
        identity: crate::IdentityPredicate {
            role: Some("group".into()),
            ..Default::default()
        },
        ..Default::default()
    };
    match mode {
        Mode::TextWitnessRemoved => query.has_text = Some("needle".into()),
        Mode::WitnessRemoved | Mode::PositiveIncompleteSuffix => {
            query.containment = containment(true)
        }
        Mode::ForbiddenAdded | Mode::NegativeIncomplete => query.containment = containment(false),
    }
    query
}

fn containment(positive: bool) -> ContainmentPredicate {
    let nested = Box::new(LocatorQuery {
        identity: crate::IdentityPredicate {
            role: Some("button".into()),
            ..Default::default()
        },
        ..Default::default()
    });
    if positive {
        ContainmentPredicate {
            has: Some(nested),
            has_not: None,
        }
    } else {
        ContainmentPredicate {
            has: None,
            has_not: Some(nested),
        }
    }
}

fn request() -> LocatorResolveRequest {
    LocatorResolveRequest {
        selection: LocatorSelection::First,
        deadline: crate::Deadline::after(5_000).unwrap(),
        max_raw_depth: 10,
        surface: None,
        materialization: LocatorMaterialization::SelectedMatches,
    }
}

fn adapter_error(error: AppError) -> AdapterError {
    match error {
        AppError::Adapter(error) => error,
        other => panic!("expected adapter error, got {other}"),
    }
}

fn root_bounds() -> Rect {
    Rect {
        x: 10.0,
        y: 20.0,
        width: 300.0,
        height: 200.0,
    }
}
